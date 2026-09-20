import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertTransition } from './task-state.mjs';
import { clampBound } from './tools/filesystem-broker.mjs';

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

export const APPROVAL_REQUEST_STATUSES = Object.freeze([
  'pending',
  'approved',
  'denied',
  'expired',
  'consumed'
]);

// Task statuses that represent in-memory execution work in flight. None of
// these can be trusted to still be "live" once the process that set them has
// disappeared (crash/restart) — the durable record alone cannot tell us
// whether the model call, handoff, or step loop that produced this status is
// still running. Startup recovery reconciles exactly these statuses into the
// existing 'paused' state (a valid transition target from all three per
// task-state.mjs) rather than assuming in-memory execution continued.
export const INTERRUPTED_EXECUTION_STATUSES = Object.freeze([
  'running',
  'switching_model',
  'validating_handoff'
]);

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|credential|auth|key|private)/i;
const MAX_CANONICAL_DEPTH = 5;
const MAX_CANONICAL_ARRAY_LEN = 50;
const MAX_CANONICAL_STRING_LEN = 4000;
const MAX_CANONICAL_KEYS = 50;

const MAX_TASK_MESSAGE_BYTES = 256 * 1024;
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

// Safe bounds for read-only evidence listing (Diff API): fixed defaults and a
// hard maximum that caller-provided limits can never exceed.
export const DEFAULT_CHANGE_EVIDENCE_LIMIT = 50;
export const MAX_CHANGE_EVIDENCE_LIMIT = 200;

function parseEvidenceRow(row) {
  try {
    row.beforeState = row.beforeStateJson ? JSON.parse(row.beforeStateJson) : null;
  } catch {
    row.beforeState = null;
  }
  try {
    row.afterState = row.afterStateJson ? JSON.parse(row.afterStateJson) : null;
  } catch {
    row.afterState = null;
  }
  delete row.beforeStateJson;
  delete row.afterStateJson;
  return row;
}

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

    CREATE TABLE IF NOT EXISTS task_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, sequence)
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
      tool_call_id TEXT,
      arguments TEXT NOT NULL,
      policy_decision TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_summary TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS file_change_evidence (
      id TEXT PRIMARY KEY,
      tool_action_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      evidence_version INTEGER NOT NULL,
      before_state TEXT,
      after_state TEXT,
      before_hash TEXT,
      after_hash TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tool_action_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);

    CREATE INDEX IF NOT EXISTS idx_task_messages_task_id_sequence ON task_messages(task_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_task_id ON checkpoints(task_id);
    CREATE INDEX IF NOT EXISTS idx_tool_actions_task_id ON tool_actions(task_id);
    CREATE INDEX IF NOT EXISTS idx_tool_actions_idempotency ON tool_actions(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_file_change_evidence_task_id ON file_change_evidence(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_change_evidence_idempotency ON file_change_evidence(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_file_change_evidence_action ON file_change_evidence(tool_action_id);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_task_id ON approval_requests(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_requests_action ON approval_requests(tool_action_id);
    CREATE INDEX IF NOT EXISTS idx_approval_requests_status_expiry ON approval_requests(status, expires_at);
  `);

  const toolActionColumns = database
    .prepare('PRAGMA table_info(tool_actions)')
    .all();

  if (!toolActionColumns.some(column => column.name === 'tool_call_id')) {
    database.exec('ALTER TABLE tool_actions ADD COLUMN tool_call_id TEXT');
  }

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

  function appendTaskMessage({
    id = randomUUID(),
    taskId,
    message,
    createdAt = new Date().toISOString()
  }) {
    if (!taskId) {
      throw new Error('taskId is required for task message');
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('message must be a non-array object');
    }

    const messageJson = JSON.stringify(message);

    if (Buffer.byteLength(messageJson, 'utf8') > MAX_TASK_MESSAGE_BYTES) {
      throw new Error(
        `Task message exceeds maximum allowed size (${MAX_TASK_MESSAGE_BYTES} bytes).`
      );
    }

    const normalizedTaskId = String(taskId);
    const messageId = String(id);
    const normalizedCreatedAt = String(createdAt);

    database.exec('BEGIN IMMEDIATE');

    try {
      const existing = database.prepare(`
        SELECT id,
               task_id AS taskId,
               sequence,
               message,
               created_at AS createdAt
        FROM task_messages
        WHERE id = ?
        LIMIT 1
      `).get(messageId);

      if (existing) {
        if (
          existing.taskId !== normalizedTaskId ||
          existing.message !== messageJson
        ) {
          throw new Error(
            'Task message identity conflict: an existing message has different content.'
          );
        }

        database.exec('COMMIT');

        return {
          id: existing.id,
          taskId: existing.taskId,
          sequence: existing.sequence,
          message: JSON.parse(existing.message),
          createdAt: existing.createdAt
        };
      }

      const nextSequence = database.prepare(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS nextSequence
        FROM task_messages
        WHERE task_id = ?
      `).get(normalizedTaskId).nextSequence;

      database.prepare(`
        INSERT INTO task_messages (
          id,
          task_id,
          sequence,
          message,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        messageId,
        normalizedTaskId,
        nextSequence,
        messageJson,
        normalizedCreatedAt
      );

      database.exec('COMMIT');

      return {
        id: messageId,
        taskId: normalizedTaskId,
        sequence: nextSequence,
        message,
        createdAt: normalizedCreatedAt
      };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function getTaskMessages(taskId) {
    if (!taskId) return [];

    const rows = database.prepare(`
      SELECT id,
             task_id AS taskId,
             sequence,
             message,
             created_at AS createdAt
      FROM task_messages
      WHERE task_id = ?
      ORDER BY sequence ASC, rowid ASC
    `).all(String(taskId));

    return rows.map(row => {
      let message;

      try {
        message = JSON.parse(row.message);
      } catch {
        throw new Error(
          `Corrupted task message payload for "${row.id}".`
        );
      }

      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error(
          `Corrupted task message payload for "${row.id}".`
        );
      }

      return {
        id: row.id,
        taskId: row.taskId,
        sequence: row.sequence,
        message,
        createdAt: row.createdAt
      };
    });
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
    toolCallId = null,
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
        id, idempotency_key, task_id, tool_name, tool_call_id, arguments,
        policy_decision, status, started_at, finished_at, result_summary, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        status = excluded.status,
        tool_call_id = COALESCE(excluded.tool_call_id, tool_actions.tool_call_id),
        finished_at = COALESCE(excluded.finished_at, tool_actions.finished_at),
        result_summary = COALESCE(excluded.result_summary, tool_actions.result_summary),
        error = COALESCE(excluded.error, tool_actions.error)
    `).run(
      actionId,
      key,
      String(taskId),
      String(toolName),
      toolCallId ? String(toolCallId).slice(0, 200) : null,
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
             tool_name AS toolName, tool_call_id AS toolCallId,
             arguments, policy_decision AS policyDecision,
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

  /**
   * Atomically claims one exact persisted tool action for approved execution.
   *
   * Claiming changes only pending -> in_progress. The approval remains
   * approved until physical execution has completed and durable success/evidence
   * has been persisted.
   */
  function claimToolActionForApproval({
    taskId,
    toolActionId,
    toolName,
    args = {}
  } = {}) {
    if (!taskId || !toolActionId || !toolName) {
      throw new Error(
        'taskId, toolActionId and toolName are required to claim an approved tool action'
      );
    }

    const normalizedTaskId = String(taskId);
    const normalizedActionId = String(toolActionId);
    const normalizedToolName = String(toolName).slice(0, 100);

    const canonicalArgs = canonicalizeToolArgs(args);
    const argumentsJson = JSON.stringify(canonicalArgs);
    const argumentsHash = createHash('sha256')
      .update(argumentsJson, 'utf8')
      .digest('hex');

    database.exec('BEGIN IMMEDIATE');

    try {
      const action = getToolAction(normalizedActionId);

      if (!action) {
        throw new Error('Tool action not found');
      }

      if (String(action.taskId) !== normalizedTaskId) {
        throw new Error('Tool action task binding mismatch');
      }

      if (String(action.toolName) !== normalizedToolName) {
        throw new Error('Tool action tool binding mismatch');
      }

      const persistedArgsJson = JSON.stringify(
        canonicalizeToolArgs(action.args || {})
      );

      if (persistedArgsJson !== argumentsJson) {
        throw new Error('Tool action argument binding mismatch');
      }

      if (action.status !== 'pending') {
        throw new Error(
          `Tool action is not claimable with status "${action.status}".`
        );
      }

      const approval = getApprovalRequestByToolAction(normalizedActionId);

      if (!approval) {
        throw new Error('Approval request not found for tool action');
      }

      if (String(approval.taskId) !== normalizedTaskId) {
        throw new Error('Approval request task binding mismatch');
      }

      if (String(approval.toolActionId) !== normalizedActionId) {
        throw new Error('Approval request tool action binding mismatch');
      }

      if (String(approval.toolName) !== normalizedToolName) {
        throw new Error('Approval request tool binding mismatch');
      }

      if (approval.argumentsHash !== argumentsHash) {
        throw new Error('Approval request argument binding mismatch');
      }

      if (approval.status !== 'approved') {
        throw new Error(
          `Approval request is not executable with status "${approval.status}".`
        );
      }

      const expiresAt = Date.parse(approval.expiresAt);

      if (!Number.isFinite(expiresAt)) {
        throw new Error('Approval request has an invalid expiration timestamp');
      }

      if (Date.now() >= expiresAt) {
        throw new Error('Approval request expired before tool action claim');
      }

      const claimed = database.prepare(`
        UPDATE tool_actions
        SET status = 'in_progress',
            started_at = ?
        WHERE id = ?
          AND task_id = ?
          AND tool_name = ?
          AND arguments = ?
          AND status = 'pending'
      `).run(
        new Date().toISOString(),
        normalizedActionId,
        normalizedTaskId,
        normalizedToolName,
        argumentsJson
      );

      if (claimed.changes !== 1) {
        throw new Error(
          'Tool action claim failed or raced with another executor'
        );
      }

      database.exec('COMMIT');

      return getToolAction(normalizedActionId);
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }

  function createApprovalRequest({
    id = randomUUID(),
    taskId,
    toolActionId,
    toolName,
    args = {},
    createdAt = new Date().toISOString(),
    expiresAt
  }) {
    if (!taskId || !toolActionId || !toolName) {
      throw new Error('taskId, toolActionId and toolName are required for approval request');
    }

    if (!expiresAt) {
      throw new Error('expiresAt is required for approval request');
    }

    const canonicalArgs = canonicalizeToolArgs(args);
    const argumentsJson = JSON.stringify(canonicalArgs);
    const argumentsHash = createHash('sha256')
      .update(argumentsJson, 'utf8')
      .digest('hex');

    const approvalId = String(id);
    const normalizedTaskId = String(taskId);
    const normalizedActionId = String(toolActionId);
    const normalizedToolName = String(toolName).slice(0, 100);
    const normalizedCreatedAt = String(createdAt);
    const normalizedExpiresAt = String(expiresAt);

    const existing = database.prepare(`
      SELECT id,
             task_id AS taskId,
             tool_action_id AS toolActionId,
             tool_name AS toolName,
             arguments,
             arguments_hash AS argumentsHash,
             status,
             created_at AS createdAt,
             expires_at AS expiresAt,
             resolved_at AS resolvedAt,
             resolution_reason AS resolutionReason
      FROM approval_requests
      WHERE id = ?
      LIMIT 1
    `).get(approvalId);

    if (existing) {
      if (
        existing.taskId !== normalizedTaskId ||
        existing.toolActionId !== normalizedActionId ||
        existing.toolName !== normalizedToolName ||
        existing.argumentsHash !== argumentsHash ||
        existing.expiresAt !== normalizedExpiresAt
      ) {
        throw new Error(
          'Approval request identity conflict: an existing approval has different bound parameters.'
        );
      }

      return parseApprovalRow(existing);
    }

    database.prepare(`
      INSERT INTO approval_requests (
        id,
        task_id,
        tool_action_id,
        tool_name,
        arguments,
        arguments_hash,
        status,
        created_at,
        expires_at,
        resolved_at,
        resolution_reason
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
    `).run(
      approvalId,
      normalizedTaskId,
      normalizedActionId,
      normalizedToolName,
      argumentsJson,
      argumentsHash,
      normalizedCreatedAt,
      normalizedExpiresAt
    );

    return getApprovalRequest(approvalId);
  }

  function parseApprovalRow(row) {
    if (!row) return null;

    try {
      row.args = JSON.parse(row.arguments);
    } catch {
      row.args = {};
    }

    delete row.arguments;
    return row;
  }

  function getApprovalRequest(id) {
    const row = database.prepare(`
      SELECT id,
             task_id AS taskId,
             tool_action_id AS toolActionId,
             tool_name AS toolName,
             arguments,
             arguments_hash AS argumentsHash,
             status,
             created_at AS createdAt,
             expires_at AS expiresAt,
             resolved_at AS resolvedAt,
             resolution_reason AS resolutionReason
      FROM approval_requests
      WHERE id = ?
      LIMIT 1
    `).get(String(id));

    return parseApprovalRow(row);
  }

  function getApprovalRequestByToolAction(toolActionId) {
    if (!toolActionId) return null;

    const row = database.prepare(`
      SELECT id,
             task_id AS taskId,
             tool_action_id AS toolActionId,
             tool_name AS toolName,
             arguments,
             arguments_hash AS argumentsHash,
             status,
             created_at AS createdAt,
             expires_at AS expiresAt,
             resolved_at AS resolvedAt,
             resolution_reason AS resolutionReason
      FROM approval_requests
      WHERE tool_action_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(String(toolActionId));

    if (!row) return null;

    return parseApprovalRow(row);
  }

  function resolveApprovalRequest(id, {
    status,
    resolvedAt = new Date().toISOString(),
    resolutionReason = null
  } = {}) {
    if (status !== 'approved' && status !== 'denied') {
      throw new Error(
        `Invalid approval resolution status: "${status}".`
      );
    }

    const approval = getApprovalRequest(id);

    if (!approval) {
      throw new Error('Approval request not found');
    }

    if (approval.status !== 'pending') {
      throw new Error(
        `Approval request is already resolved with status "${approval.status}".`
      );
    }

    const expiresAt = Date.parse(approval.expiresAt);

    if (!Number.isFinite(expiresAt)) {
      throw new Error('Approval request has an invalid expiration timestamp');
    }

    if (Date.now() >= expiresAt) {
      database.prepare(`
        UPDATE approval_requests
        SET status = 'expired',
            resolved_at = ?,
            resolution_reason = ?
        WHERE id = ? AND status = 'pending'
      `).run(
        String(resolvedAt),
        'Approval request expired before resolution.',
        String(id)
      );

      return getApprovalRequest(id);
    }

    database.prepare(`
      UPDATE approval_requests
      SET status = ?,
          resolved_at = ?,
          resolution_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(
      String(status),
      String(resolvedAt),
      resolutionReason ? String(resolutionReason).slice(0, 500) : null,
      String(id)
    );

    const resolved = getApprovalRequest(id);

    if (!resolved || resolved.status !== status) {
      throw new Error(
        'Approval resolution failed or raced with another resolution'
      );
    }

    return resolved;
  }

  function consumeApprovalRequest(id, {
    taskId,
    toolActionId,
    toolName,
    args = {}
  } = {}) {
    if (!id || !taskId || !toolActionId || !toolName) {
      throw new Error(
        'id, taskId, toolActionId and toolName are required to consume approval'
      );
    }

    const approval = getApprovalRequest(id);

    if (!approval) {
      throw new Error('Approval request not found');
    }

    if (String(approval.taskId) !== String(taskId)) {
      throw new Error('Approval request task binding mismatch');
    }

    if (String(approval.toolActionId) !== String(toolActionId)) {
      throw new Error('Approval request tool action binding mismatch');
    }

    if (String(approval.toolName) !== String(toolName)) {
      throw new Error('Approval request tool binding mismatch');
    }

    const canonicalArgs = JSON.stringify(canonicalizeToolArgs(args));
    const argumentsHash = createHash('sha256')
      .update(canonicalArgs, 'utf8')
      .digest('hex');

    if (approval.argumentsHash !== argumentsHash) {
      throw new Error('Approval request argument binding mismatch');
    }

    if (approval.status !== 'approved') {
      throw new Error(
        `Approval request is not consumable with status "${approval.status}".`
      );
    }

    const expiresAt = Date.parse(approval.expiresAt);

    if (!Number.isFinite(expiresAt)) {
      throw new Error('Approval request has an invalid expiration timestamp');
    }

    if (Date.now() >= expiresAt) {
      throw new Error('Approval request expired before consumption');
    }

    const resolved = database.prepare(`
      UPDATE approval_requests
      SET status = 'consumed'
      WHERE id = ?
        AND status = 'approved'
        AND task_id = ?
        AND tool_action_id = ?
        AND tool_name = ?
        AND arguments_hash = ?
        AND expires_at > ?
    `).run(
      String(id),
      String(taskId),
      String(toolActionId),
      String(toolName),
      argumentsHash,
      new Date().toISOString()
    );

    if (resolved.changes !== 1) {
      throw new Error(
        'Approval consumption failed or raced with another consumer'
      );
    }

    return getApprovalRequest(id);
  }

  // ── Filesystem change evidence ──────────────────────────────────────────────

  /**
   * Inserts one file-change evidence row. The idempotency key is UNIQUE and
   * shared with the corresponding tool action, so replayed completions can
   * never create conflicting duplicate evidence (existing row is kept).
   */
  function insertFileChangeEvidenceInternal(evidence) {
    if (!evidence || typeof evidence !== 'object') {
      throw new Error('File change evidence object is required.');
    }

    for (const field of ['toolActionId', 'idempotencyKey', 'taskId', 'toolName', 'operation', 'relativePath']) {
      if (!evidence[field]) {
        throw new Error(`File change evidence requires ${field}.`);
      }
    }
    if (!Number.isInteger(evidence.evidenceVersion)) {
      throw new Error('File change evidence requires an integer evidenceVersion.');
    }

    const beforeJson =
      evidence.beforeState === undefined || evidence.beforeState === null
        ? null
        : JSON.stringify(evidence.beforeState);
    const afterJson =
      evidence.afterState === undefined || evidence.afterState === null
        ? null
        : JSON.stringify(evidence.afterState);

    const toolActionId = String(evidence.toolActionId);
    const idempotencyKey = String(evidence.idempotencyKey);
    const taskId = String(evidence.taskId);
    // Normalized exactly as persisted so identity comparison is stable.
    const toolName = String(evidence.toolName).slice(0, 100);
    const operation = String(evidence.operation).slice(0, 20);
    const relativePath = String(evidence.relativePath).slice(0, 1000);

    // Fail closed on idempotency-key reuse: an existing evidence row is only a
    // legitimate replay when every identity field matches the incoming
    // evidence. Any conflict throws (and rolls back the surrounding success
    // transaction) instead of silently returning the existing row.
    const existing = database.prepare(`
      SELECT tool_action_id, task_id, tool_name, operation, relative_path
      FROM file_change_evidence
      WHERE idempotency_key = ?
    `).get(idempotencyKey);

    if (existing) {
      const identityFields = [
        ['toolActionId', existing.tool_action_id, toolActionId],
        ['taskId', existing.task_id, taskId],
        ['toolName', existing.tool_name, toolName],
        ['operation', existing.operation, operation],
        ['relativePath', existing.relative_path, relativePath]
      ];

      for (const [field, stored, incoming] of identityFields) {
        if (stored !== incoming) {
          throw new Error(
            `File change evidence idempotency conflict: ${field} does not match the existing evidence for this tool action.`
          );
        }
      }

      return getToolActionEvidence(idempotencyKey);
    }

    database.prepare(`
      INSERT INTO file_change_evidence (
        id, tool_action_id, idempotency_key, task_id, tool_name, operation,
        relative_path, evidence_version, before_state, after_state,
        before_hash, after_hash, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(evidence.id || randomUUID()),
      toolActionId,
      idempotencyKey,
      taskId,
      toolName,
      operation,
      relativePath,
      evidence.evidenceVersion,
      beforeJson,
      afterJson,
      evidence.beforeState?.hash ? String(evidence.beforeState.hash) : null,
      evidence.afterState?.hash ? String(evidence.afterState.hash) : null,
      String(evidence.capturedAt || new Date().toISOString())
    );

    return getToolActionEvidence(idempotencyKey);
  }

  function getToolActionEvidence(idOrKey) {
    const row = database.prepare(`
      SELECT id, tool_action_id AS toolActionId, idempotency_key AS idempotencyKey,
             task_id AS taskId, tool_name AS toolName, operation,
             relative_path AS relativePath, evidence_version AS evidenceVersion,
             before_state AS beforeStateJson, after_state AS afterStateJson,
             before_hash AS beforeHash, after_hash AS afterHash,
             captured_at AS capturedAt
      FROM file_change_evidence
      WHERE tool_action_id = ? OR idempotency_key = ?
      ORDER BY captured_at DESC, rowid DESC
      LIMIT 1
    `).get(String(idOrKey), String(idOrKey));

    if (!row) return null;

    try {
      row.beforeState = row.beforeStateJson ? JSON.parse(row.beforeStateJson) : null;
    } catch {
      row.beforeState = null;
    }
    try {
      row.afterState = row.afterStateJson ? JSON.parse(row.afterStateJson) : null;
    } catch {
      row.afterState = null;
    }
    delete row.beforeStateJson;
    delete row.afterStateJson;
    return row;
  }

  // Read-only retrieval of file change evidence for the Diff API. Deterministic
  // ordering (capture time, rowid tie-breaker), parameterized queries, and
  // clamped caller limits so no caller input can bypass safe bounds. This
  // helper never writes and never touches the filesystem.
  function getFileChangeEvidence({ taskId, path = null, limit } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) {
      throw new Error('taskId is required to retrieve file change evidence.');
    }

    let requestedLimit = limit;
    if (typeof requestedLimit === 'string') {
      const trimmed = requestedLimit.trim();
      requestedLimit = trimmed === '' ? undefined : Number(trimmed);
    }
    const effectiveLimit = clampBound(
      requestedLimit,
      DEFAULT_CHANGE_EVIDENCE_LIMIT,
      MAX_CHANGE_EVIDENCE_LIMIT,
      1
    );

    const parameters = [String(taskId)];
    let whereClause = 'WHERE task_id = ?';
    if (path !== null && path !== undefined) {
      whereClause += ' AND relative_path = ?';
      parameters.push(String(path));
    }

    const rows = database.prepare(`
      SELECT id, tool_action_id AS toolActionId, idempotency_key AS idempotencyKey,
             task_id AS taskId, tool_name AS toolName, operation,
             relative_path AS relativePath, evidence_version AS evidenceVersion,
             before_state AS beforeStateJson, after_state AS afterStateJson,
             before_hash AS beforeHash, after_hash AS afterHash,
             captured_at AS capturedAt
      FROM file_change_evidence
      ${whereClause}
      ORDER BY captured_at ASC, rowid ASC
      LIMIT ?
    `).all(...parameters, effectiveLimit);

    const total = database.prepare(`
      SELECT COUNT(*) AS count FROM file_change_evidence ${whereClause}
    `).get(...parameters).count;

    return {
      limit: effectiveLimit,
      total,
      truncated: total > rows.length,
      changes: rows.map(parseEvidenceRow)
    };
  }

  /**
   * Marks a tool action successful and persists its filesystem change evidence
   * in ONE transaction. Evidence can therefore never exist for a tool action
   * that is not recorded as success, and an evidence persistence failure rolls
   * the success transition back so the caller can park the action for
   * verification instead of claiming an attested change.
   */
  function completeToolActionWithEvidence({ actionRecord, resultSummary = null, evidence = null }) {
    if (!actionRecord || !actionRecord.idempotencyKey) {
      throw new Error('Completing a tool action with evidence requires the pending action record.');
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      recordToolAction({
        ...actionRecord,
        status: 'success',
        finishedAt: actionRecord.finishedAt || new Date().toISOString(),
        resultSummary
      });

      let evidenceRecord = null;
      if (evidence) {
        evidenceRecord = insertFileChangeEvidenceInternal(evidence);
      }

      database.exec('COMMIT');

      return {
        action: getToolAction(actionRecord.idempotencyKey),
        evidence: evidenceRecord
      };
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
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

  // ── Durable startup recovery reconciliation ─────────────────────────────

  /**
   * Same durable-transition contract as recordTaskTransition (one
   * transaction: checkpoint(s) -> event -> task snapshot -> commit, full
   * rollback on any failure) but additionally binds the write to the task's
   * *currently persisted* status, re-read inside the same transaction.
   *
   * This exists specifically for startup reconciliation: the candidate task
   * list is gathered by an earlier, separate read (getTasks()), so by the
   * time a given task's reconciliation actually runs, another writer could
   * in principle have already moved it on (e.g. resolved its approval,
   * completed it, etc.). Re-checking status under the write lock, and
   * basing the persisted payload on the freshly re-read row rather than the
   * stale scanned copy, guarantees reconciliation can never clobber a
   * concurrent lifecycle change with stale data. If the status no longer
   * matches, the whole transaction is rolled back and the task is left
   * completely untouched.
   */
  function recordTaskTransitionIfCurrentStatus({
    taskId,
    expectedPreviousStatus,
    nextStatus,
    reason,
    buildCheckpoint,
    buildReason
  }) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const row = database.prepare('SELECT payload FROM tasks WHERE id = ?').get(String(taskId));
      const freshTask = row ? JSON.parse(row.payload) : null;

      if (!freshTask || freshTask.status !== expectedPreviousStatus) {
        database.exec('ROLLBACK');
        return {
          ok: false,
          skipped: true,
          taskId,
          currentStatus: freshTask ? freshTask.status : null,
          reason: 'Task status changed since reconciliation scan; skipped to avoid overwriting a concurrent lifecycle change.'
        };
      }

      const latestCheckpoint = getLatestCheckpoint(taskId);
      const finalReason = buildReason
        ? buildReason({ task: freshTask, latestCheckpoint })
        : reason;

      const cp = buildCheckpoint
        ? buildCheckpoint({ task: freshTask, latestCheckpoint, reason: finalReason })
        : null;

      let lastCpRecord = null;
      if (cp) {
        lastCpRecord = recordCheckpointInternal({ ...cp, taskId: cp.taskId || taskId });
      }

      const eventRecord = recordTaskEventInternal({
        taskId,
        previousStatus: expectedPreviousStatus,
        nextStatus,
        timestamp: new Date().toISOString(),
        reason: finalReason,
        checkpointId: lastCpRecord ? lastCpRecord.id : null
      });

      const reconciledTask = {
        ...freshTask,
        status: nextStatus,
        message: finalReason,
        updatedAt: eventRecord.timestamp,
        checkpoints: lastCpRecord
          ? [...(Array.isArray(freshTask.checkpoints) ? freshTask.checkpoints : []), lastCpRecord]
          : (Array.isArray(freshTask.checkpoints) ? freshTask.checkpoints : [])
      };

      upsertTaskInternal(reconciledTask);

      database.exec('COMMIT');

      return {
        ok: true,
        taskId,
        task: reconciledTask,
        event: eventRecord,
        checkpoint: lastCpRecord
      };
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Reconciles tasks whose durable status is one of
   * INTERRUPTED_EXECUTION_STATUSES into the existing 'paused' state.
   *
   * Runs automatically once on every openStore() (see bottom of this
   * function) — the same "reconcile on reopen" precedent already used
   * above for pending/in_progress tool actions — and is also exposed on the
   * store so callers/tests can invoke it explicitly.
   *
   * - Never invokes a model or a tool: this only ever moves a task's status
   *   and records bookkeeping (task event + checkpoint), so requirements 3/4
   *   (no automatic replay of model invocation or tool re-execution) hold
   *   trivially — there is no code path here that can reach either.
   * - Never touches task_messages: the durable transcript is left exactly
   *   as persisted (requirement 15).
   * - Never touches tool_actions or approval_requests: pending/in_progress
   *   tool-action recovery (already fail-closed, above) and
   *   awaiting_approval tasks are completely untouched (requirements 11-14).
   * - A corrupted latest checkpoint is detected and named in the transition
   *   reason/message, but the corrupted row itself is never modified,
   *   replaced, or deleted — it stays in the checkpoints table exactly as
   *   found, preserved as evidence.
   * - Idempotent: once a task is reconciled its status is 'paused', which is
   *   no longer in INTERRUPTED_EXECUTION_STATUSES, so re-running this is a
   *   no-op for that task (no duplicate event, checkpoint, or execution).
   * - Fail-closed per task: a task that cannot be reconciled (unexpected
   *   error, or its status changed concurrently) is skipped/reported rather
   *   than throwing and aborting reconciliation for the rest of the set.
   *
   * @param {(task: object) => void} [_testSeam] - optional hook invoked with
   *   the scanned (pre-reconciliation) task copy just before its guarded
   *   transactional write executes, for tests to simulate a concurrent
   *   external status change between the scan and the write.
   */
  function reconcileInterruptedTasks(_testSeam = null) {
    const results = [];
    const scannedTasks = getTasks();

    for (const scannedTask of scannedTasks) {
      if (!scannedTask || !INTERRUPTED_EXECUTION_STATUSES.includes(scannedTask.status)) {
        continue;
      }

      const taskId = scannedTask.id;
      const previousStatus = scannedTask.status;

      try {
        if (typeof _testSeam === 'function') {
          _testSeam({ ...scannedTask });
        }

        const outcome = recordTaskTransitionIfCurrentStatus({
          taskId,
          expectedPreviousStatus: previousStatus,
          nextStatus: 'paused',
          buildReason: ({ task, latestCheckpoint }) => {
            let checkpointNote;
            let corrupted = false;

            if (latestCheckpoint) {
              const verification = verifyCheckpoint(latestCheckpoint);
              corrupted = !verification.valid;
              checkpointNote = verification.valid
                ? `Last durable checkpoint "${latestCheckpoint.id}" (step ${latestCheckpoint.step}) verified intact.`
                : `Last durable checkpoint "${latestCheckpoint.id}" failed integrity verification (${verification.reason}); it has been preserved unchanged and requires manual verification before this task can safely resume.`;
            } else {
              checkpointNote = 'No durable checkpoint was recorded before the interruption.';
            }

            return (
              `Startup recovery: task was interrupted while "${previousStatus}" ` +
              `(the process stopped before it reached a durable resting state) ` +
              `and has been paused pending explicit resume. ${checkpointNote}`
            );
          },
          buildCheckpoint: ({ task, latestCheckpoint, reason }) => {
            // A corrupted checkpoint must remain the latest durable evidence so
            // the existing recoverTask() path can continue to fail closed on
            // explicit resume. Never replace or supersede corrupted evidence.
            if (latestCheckpoint) {
              const verification = verifyCheckpoint(latestCheckpoint);
              if (!verification.valid) return null;
            }

            const cpData = {
              id: randomUUID(),
              taskId,
              createdAt: new Date().toISOString(),
              event: `Startup recovery: reconciled from "${previousStatus}"`,
              status: 'paused',
              activeModel: task.activeModel || latestCheckpoint?.activeModel || '',
              step: Array.isArray(task.steps) ? task.steps.length : (latestCheckpoint?.step || 0),
              workspace: latestCheckpoint?.workspace || ''
            };
            return {
              ...cpData,
              integrityHash: computeCheckpointHash(cpData)
            };
          }
        });

        results.push({
          taskId,
          previousStatus,
          ...outcome
        });
      } catch (err) {
        // Fail closed per task: one malformed/unreconcilable task must never
        // abort reconciliation for the rest of the durable task set, and the
        // failure must never be silently swallowed either.
        results.push({
          ok: false,
          taskId,
          previousStatus,
          error: err.message
        });
      }
    }

    return results;
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

  // On store (re)open, deterministically reconcile any task left in an
  // execution-related status (running / switching_model / validating_handoff)
  // into the existing 'paused' state — mirroring the pending/in_progress
  // tool-action reconciliation above. See reconcileInterruptedTasks() for
  // the full contract.
  reconcileInterruptedTasks();

  return {
    getTasks,
    saveTasks,
    getTask,

    appendTaskMessage,
    getTaskMessages,
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
    claimToolActionForApproval,
    createApprovalRequest,
    getApprovalRequest,
    getApprovalRequestByToolAction,
    resolveApprovalRequest,
    consumeApprovalRequest,
    completeToolActionWithEvidence,
    getToolActionEvidence,
    getFileChangeEvidence,
    recoverTask,
    reconcileInterruptedTasks,
    getConfig,
    saveConfig,
    close,
    get database() { return database; }
  };
}
