import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertTransition } from './task-state.mjs';

const parseFile = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
};

// ── Checkpoint integrity ─────────────────────────────────────────────────────

/**
 * Computes a deterministic SHA-256 integrity hash over the canonical
 * representation of a checkpoint's persisted fields.
 */
export function computeCheckpointHash(cp = {}) {
  const canonical = {
    activeModel: String(cp.activeModel || cp.active_model || '').slice(0, 200),
    createdAt: String(cp.createdAt || cp.created_at || '').slice(0, 100),
    event: String(cp.event || '').slice(0, 1000),
    id: String(cp.id || cp.checkpoint_id || '').slice(0, 100),
    status: String(cp.status || '').slice(0, 50),
    step: Number(cp.step) || 0,
    taskId: String(cp.taskId || cp.task_id || '').slice(0, 100),
    workspace: String(cp.workspace || '').slice(0, 1000)
  };
  const jsonStr = JSON.stringify(canonical);
  return createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

/**
 * Verifies that a checkpoint's integrity hash matches its canonical content.
 */
export function verifyCheckpoint(cp) {
  if (!cp || typeof cp !== 'object') {
    return { valid: false, reason: 'Invalid checkpoint record' };
  }
  const actualHash = cp.integrityHash || cp.integrity_hash;
  if (!actualHash || typeof actualHash !== 'string') {
    return { valid: false, reason: 'Missing integrity hash' };
  }
  const expectedHash = computeCheckpointHash(cp);
  if (expectedHash !== actualHash) {
    return {
      valid: false,
      reason: `Integrity hash mismatch: expected ${expectedHash}, got ${actualHash}`
    };
  }
  return { valid: true, hash: actualHash };
}

// ── Tool argument canonicalization and idempotency ─────────────────────────────

export const TOOL_ACTION_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'success',
  'failure',
  'needs_verification'
]);

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|credential|auth|key|private)/i;
const MAX_CANONICAL_DEPTH = 5;
const MAX_CANONICAL_ARRAY_LEN = 50;
const MAX_CANONICAL_STRING_LEN = 4000;
const MAX_CANONICAL_KEYS = 50;

function hashSensitiveValue(val) {
  const digest = createHash('sha256').update(String(val), 'utf8').digest('hex');
  return `[REDACTED:sha256:${digest}]`;
}

/**
 * Recursively canonicalizes tool arguments:
 * - Bounds array length and object depth.
 * - Slices strings to max lengths.
 * - One-way hashes sensitive scalar values (preserving secret-free persistence while
 *   ensuring different secret values yield distinct idempotency keys).
 */
export function canonicalizeToolArgs(val, depth = 0, isSensitiveParent = false) {
  if (depth > MAX_CANONICAL_DEPTH) {
    return '[TRUNCATED_DEPTH]';
  }

  if (val === null || val === undefined) {
    return val;
  }

  if (typeof val === 'string') {
    if (isSensitiveParent) {
      return hashSensitiveValue(val);
    }
    return val.slice(0, MAX_CANONICAL_STRING_LEN);
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    if (isSensitiveParent) {
      return hashSensitiveValue(val);
    }
    return val;
  }

  if (Array.isArray(val)) {
    const boundedArray = val.slice(0, MAX_CANONICAL_ARRAY_LEN);
    return boundedArray.map(item => canonicalizeToolArgs(item, depth + 1, isSensitiveParent));
  }

  if (typeof val === 'object') {
    const clean = {};
    const keys = Object.keys(val).sort().slice(0, MAX_CANONICAL_KEYS);
    for (const k of keys) {
      const isSensitiveKey = isSensitiveParent || SENSITIVE_KEY_PATTERN.test(k);
      clean[k] = canonicalizeToolArgs(val[k], depth + 1, isSensitiveKey);
    }
    return clean;
  }

  return String(val).slice(0, MAX_CANONICAL_STRING_LEN);
}

/**
 * Computes a deterministic idempotency key for a logical tool action.
 */
export function computeToolIdempotencyKey({ taskId, toolName, args = {} }) {
  const canonical = {
    args: canonicalizeToolArgs(args),
    taskId: String(taskId || ''),
    toolName: String(toolName || '')
  };
  const jsonStr = JSON.stringify(canonical);
  return createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

// ── Open store ───────────────────────────────────────────────────────────────

export async function openStore(dataRoot) {
  const database = new DatabaseSync(join(dataRoot, 'continuity-agent.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      previous_status TEXT NOT NULL,
      next_status TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      reason TEXT,
      checkpoint_id TEXT
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      active_model TEXT NOT NULL,
      step INTEGER NOT NULL,
      event TEXT NOT NULL,
      workspace TEXT,
      integrity_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_actions (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      task_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      policy_decision TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_summary TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_task_id ON checkpoints(task_id);
    CREATE INDEX IF NOT EXISTS idx_tool_actions_task_id ON tool_actions(task_id);
    CREATE INDEX IF NOT EXISTS idx_tool_actions_idempotency ON tool_actions(idempotency_key);
  `);

  // On reopening store, mark any pending or in_progress tool actions as needs_verification
  database.exec(`
    UPDATE tool_actions
    SET status = 'needs_verification'
    WHERE status IN ('pending', 'in_progress');
  `);

  // Migration from legacy JSON files when database is empty
  const count = database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  const legacyTasks = join(dataRoot, 'tasks.json');
  if (count === 0 && existsSync(legacyTasks)) {
    const insert = database.prepare('INSERT OR REPLACE INTO tasks (id, payload, updated_at) VALUES (?, ?, ?)');
    for (const task of await parseFile(legacyTasks, [])) {
      insert.run(task.id, JSON.stringify(task), task.updatedAt || task.createdAt || new Date().toISOString());
    }
  }

  const legacyConfig = join(dataRoot, 'config.json');
  const hasConfig = database.prepare("SELECT 1 FROM app_config WHERE key = 'runtime'").get();
  if (!hasConfig && existsSync(legacyConfig)) {
    const config = await parseFile(legacyConfig, {});
    database.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run(
      'runtime',
      JSON.stringify(config),
      new Date().toISOString()
    );
  }

  // ── Internal mutation operations (uncommitted, for transactions) ───────────

  function upsertTaskInternal(task) {
    if (!task || !task.id) throw new Error('task with an id is required');
    const updatedAt = task.updatedAt || new Date().toISOString();
    database.prepare(`
      INSERT INTO tasks (id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(String(task.id), JSON.stringify(task), String(updatedAt));
    return task;
  }

  function recordCheckpointInternal(cp) {
    const taskId = cp.taskId || cp.task_id;
    if (!taskId) throw new Error('taskId is required for checkpoint');

    const checkpointId = String(cp.id || randomUUID());
    const createdAt = String(cp.createdAt || cp.created_at || new Date().toISOString());
    const status = String(cp.status || 'running').slice(0, 50);
    const activeModel = String(cp.activeModel || cp.active_model || '').slice(0, 200);
    const step = Number(cp.step) || 0;
    const event = String(cp.event || '').slice(0, 1000);
    const workspace = String(cp.workspace || '').slice(0, 1000);

    // ALWAYS recompute SHA-256 from the canonical persisted checkpoint fields
    const computedHash = computeCheckpointHash({
      id: checkpointId,
      taskId,
      createdAt,
      status,
      activeModel,
      step,
      event,
      workspace
    });

    // If caller supplied an integrityHash, it must strictly match the computed hash
    const suppliedHash = cp.integrityHash || cp.integrity_hash;
    if (suppliedHash && suppliedHash !== computedHash) {
      throw new Error(
        `Invalid checkpoint integrity hash: supplied ${suppliedHash} does not match computed ${computedHash}`
      );
    }

    database.prepare(`
      INSERT OR REPLACE INTO checkpoints (
        id, task_id, created_at, status, active_model, step, event, workspace, integrity_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpointId,
      String(taskId),
      createdAt,
      status,
      activeModel,
      step,
      event,
      workspace,
      computedHash
    );

    return {
      id: checkpointId,
      taskId: String(taskId),
      createdAt,
      status,
      activeModel,
      step,
      event,
      workspace,
      integrityHash: computedHash
    };
  }

  function recordTaskEventInternal({
    id = randomUUID(),
    taskId,
    previousStatus,
    nextStatus,
    timestamp = new Date().toISOString(),
    reason = '',
    checkpointId = null
  }) {
    if (!taskId) throw new Error('taskId is required for task event');
    if (!previousStatus || !nextStatus) {
      throw new Error('previousStatus and nextStatus are required for task event');
    }

    // Reuse task-state transition rules to reject invalid state transitions
    assertTransition(previousStatus, nextStatus);

    const eventId = String(id);
    const boundedReason = String(reason || '').slice(0, 1000);

    database.prepare(`
      INSERT INTO task_events (id, task_id, previous_status, next_status, timestamp, reason, checkpoint_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      String(taskId),
      String(previousStatus),
      String(nextStatus),
      String(timestamp),
      boundedReason,
      checkpointId ? String(checkpointId) : null
    );

    return {
      id: eventId,
      taskId,
      previousStatus,
      nextStatus,
      timestamp,
      reason: boundedReason,
      checkpointId: checkpointId ? String(checkpointId) : null
    };
  }

  // ── Public Store API ───────────────────────────────────────────────────────

  function getTasks() {
    return database.prepare('SELECT payload FROM tasks ORDER BY updated_at DESC')
      .all()
      .map(row => JSON.parse(row.payload));
  }

  function saveTasks(tasks) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('DELETE FROM tasks');
      const insert = database.prepare('INSERT INTO tasks (id, payload, updated_at) VALUES (?, ?, ?)');
      for (const task of tasks) {
        insert.run(task.id, JSON.stringify(task), task.updatedAt || new Date().toISOString());
      }
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }

  function getTask(taskId) {
    const row = database.prepare('SELECT payload FROM tasks WHERE id = ?').get(String(taskId));
    return row ? JSON.parse(row.payload) : null;
  }

  function upsertTask(task) {
    return upsertTaskInternal(task);
  }

  function recordTaskEvent(params) {
    return recordTaskEventInternal(params);
  }

  function getTaskEvents(taskId) {
    return database.prepare(`
      SELECT id, task_id AS taskId, previous_status AS previousStatus,
             next_status AS nextStatus, timestamp, reason, checkpoint_id AS checkpointId
      FROM task_events
      WHERE task_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(String(taskId));
  }

  function recordCheckpoint(cp) {
    return recordCheckpointInternal(cp);
  }

  function getLatestCheckpoint(taskId) {
    const row = database.prepare(`
      SELECT id, task_id AS taskId, created_at AS createdAt,
             status, active_model AS activeModel, step, event,
             workspace, integrity_hash AS integrityHash
      FROM checkpoints
      WHERE task_id = ?
      ORDER BY step DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get(String(taskId));

    return row || null;
  }

  function getCheckpoints(taskId) {
    return database.prepare(`
      SELECT id, task_id AS taskId, created_at AS createdAt,
             status, active_model AS activeModel, step, event,
             workspace, integrity_hash AS integrityHash
      FROM checkpoints
      WHERE task_id = ?
      ORDER BY step ASC, created_at ASC, rowid ASC
    `).all(String(taskId));
  }

  /**
   * Atomically persists task snapshot, state transition event, and checkpoint.
   * If any part fails (e.g. invalid state transition or invalid checkpoint hash),
   * the entire transaction rolls back so events or checkpoints are never left ahead of the task snapshot.
   */
  function recordTaskTransition({
    task,
    previousStatus,
    nextStatus,
    reason = '',
    checkpoint = null,
    checkpoints = [],
    _testSeam = null
  }) {
    const cps = checkpoints.length > 0 ? checkpoints : (checkpoint ? [checkpoint] : []);

    database.exec('BEGIN IMMEDIATE');
    try {
      let lastCpRecord = null;
      for (const cp of cps) {
        lastCpRecord = recordCheckpointInternal({
          ...cp,
          taskId: cp.taskId || cp.task_id || task.id
        });
      }

      if (_testSeam === 'after_checkpoint') {
        throw new Error('Simulated failure at test seam: after_checkpoint');
      }

      let eventRecord = null;
      if (previousStatus && nextStatus && previousStatus !== nextStatus) {
        eventRecord = recordTaskEventInternal({
          taskId: task.id,
          previousStatus,
          nextStatus,
          timestamp: task.updatedAt || new Date().toISOString(),
          reason: reason || task.message || `Transition to ${nextStatus}`,
          checkpointId: lastCpRecord ? lastCpRecord.id : null
        });
      }

      if (_testSeam === 'after_event') {
        throw new Error('Simulated failure at test seam: after_event');
      }

      if (typeof _testSeam === 'function') {
        _testSeam({ task, lastCpRecord, eventRecord });
      }

      if (task) {
        upsertTaskInternal(task);
      }

      if (_testSeam === 'before_commit') {
        throw new Error('Simulated failure at test seam: before_commit');
      }

      database.exec('COMMIT');

      return {
        task,
        event: eventRecord,
        checkpoint: lastCpRecord
      };
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }

  function recordToolAction({
    id = randomUUID(),
    idempotencyKey,
    taskId,
    toolName,
    args = {},
    policyDecision = 'allowed',
    status = 'pending',
    startedAt = new Date().toISOString(),
    finishedAt = null,
    resultSummary = null,
    error = null
  }) {
    if (!taskId || !toolName) {
      throw new Error('taskId and toolName are required for tool action');
    }

    if (status && !TOOL_ACTION_STATUSES.includes(status)) {
      throw new Error(`Invalid tool action status: "${status}". Supported statuses are: ${TOOL_ACTION_STATUSES.join(', ')}`);
    }

    const key = idempotencyKey || computeToolIdempotencyKey({ taskId, toolName, args });
    const actionId = String(id);
    const canonicalArgs = JSON.stringify(canonicalizeToolArgs(args));
    const boundedSummary = resultSummary ? String(resultSummary).slice(0, 12_000) : null;
    const boundedError = error ? String(error).slice(0, 2000) : null;

    database.prepare(`
      INSERT INTO tool_actions (
        id, idempotency_key, task_id, tool_name, arguments,
        policy_decision, status, started_at, finished_at, result_summary, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        status = excluded.status,
        finished_at = COALESCE(excluded.finished_at, tool_actions.finished_at),
        result_summary = COALESCE(excluded.result_summary, tool_actions.result_summary),
        error = COALESCE(excluded.error, tool_actions.error)
    `).run(
      actionId,
      key,
      String(taskId),
      String(toolName),
      canonicalArgs,
      String(policyDecision).slice(0, 50),
      String(status).slice(0, 50),
      String(startedAt),
      finishedAt ? String(finishedAt) : null,
      boundedSummary,
      boundedError
    );

    return getToolAction(key);
  }

  function getToolAction(idOrKey) {
    const row = database.prepare(`
      SELECT id, idempotency_key AS idempotencyKey, task_id AS taskId,
             tool_name AS toolName, arguments, policy_decision AS policyDecision,
             status, started_at AS startedAt, finished_at AS finishedAt,
             result_summary AS resultSummary, error
      FROM tool_actions
      WHERE id = ? OR idempotency_key = ?
      LIMIT 1
    `).get(String(idOrKey), String(idOrKey));

    if (!row) return null;
    try {
      row.args = JSON.parse(row.arguments);
    } catch {
      row.args = {};
    }
    return row;
  }

  function getCompletedToolAction(taskIdOrKey, toolName, args) {
    let key;
    if (toolName === undefined && args === undefined) {
      key = taskIdOrKey;
    } else {
      key = computeToolIdempotencyKey({ taskId: taskIdOrKey, toolName, args });
    }
    const action = getToolAction(key);
    if (action && action.status === 'success') {
      return action;
    }
    return null;
  }

  function recoverTask(taskId) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'Task not found' };

    const latestCheckpoint = getLatestCheckpoint(taskId);
    if (latestCheckpoint) {
      const verification = verifyCheckpoint(latestCheckpoint);
      if (!verification.valid) {
        return {
          ok: false,
          error: `Corrupted checkpoint integrity: ${verification.reason}`,
          corruptedCheckpoint: latestCheckpoint,
          task
        };
      }
    }

    return {
      ok: true,
      task,
      latestCheckpoint
    };
  }

  function getConfig() {
    const row = database.prepare("SELECT value FROM app_config WHERE key = 'runtime'").get();
    return row ? JSON.parse(row.value) : {};
  }

  function saveConfig(config) {
    database.prepare(`
      INSERT INTO app_config (key, value, updated_at)
      VALUES ('runtime', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(config), new Date().toISOString());
  }

  function close() {
    database.close();
  }

  return {
    getTasks,
    saveTasks,
    getTask,
    upsertTask,
    recordTaskEvent,
    getTaskEvents,
    recordCheckpoint,
    getLatestCheckpoint,
    getCheckpoints,
    recordTaskTransition,
    verifyCheckpoint,
    recordToolAction,
    getToolAction,
    getCompletedToolAction,
    recoverTask,
    getConfig,
    saveConfig,
    close,
    get database() { return database; }
  };
}
