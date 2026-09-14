import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openStore,
  computeCheckpointHash,
  verifyCheckpoint,
  canonicalizeToolArgs,
  computeToolIdempotencyKey,
  TOOL_ACTION_STATUSES
} from '../src/store.mjs';
import { createOrchestrator } from '../src/orchestrator/orchestrator.mjs';

// ── Tests ────────────────────────────────────────────────────────────────────

test('1. opening a new SQLite store creates required schema and default tables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);
    assert.deepEqual(store.getTasks(), []);
    assert.deepEqual(store.getConfig(), {});
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('2. task persistence across close/reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store1 = await openStore(dir);
    const task = {
      id: 'task-100',
      goal: 'Durable task test',
      status: 'queued',
      message: 'Initial state',
      activeModel: 'qwen3:4b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: []
    };

    store1.upsertTask(task);
    assert.equal(store1.getTask('task-100')?.id, 'task-100');
    store1.close();

    // Reopen store from same directory
    const store2 = await openStore(dir);
    const recovered = store2.getTask('task-100');
    assert.ok(recovered);
    assert.equal(recovered.id, 'task-100');
    assert.equal(recovered.goal, 'Durable task test');
    assert.equal(recovered.status, 'queued');

    const allTasks = store2.getTasks();
    assert.equal(allTasks.length, 1);
    assert.equal(allTasks[0].id, 'task-100');
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('3. config persistence across close/reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store1 = await openStore(dir);
    const config = {
      preferredModel: 'qwen3:4b',
      maxSteps: 8,
      allowedCommands: ['git', 'npm']
    };

    store1.saveConfig(config);
    store1.close();

    const store2 = await openStore(dir);
    const loaded = store2.getConfig();
    assert.equal(loaded.preferredModel, 'qwen3:4b');
    assert.equal(loaded.maxSteps, 8);
    assert.deepEqual(loaded.allowedCommands, ['git', 'npm']);
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('4. checkpoint persistence and retrieval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);
    const cp = store.recordCheckpoint({
      id: 'cp-1',
      taskId: 'task-1',
      status: 'running',
      activeModel: 'qwen3:4b',
      step: 1,
      event: 'Step 1 completed',
      workspace: '/tmp/project'
    });

    assert.ok(cp.integrityHash);
    assert.equal(cp.step, 1);

    const latest = store.getLatestCheckpoint('task-1');
    assert.ok(latest);
    assert.equal(latest.id, 'cp-1');
    assert.equal(latest.taskId, 'task-1');
    assert.equal(latest.integrityHash, cp.integrityHash);

    // Record step 2
    store.recordCheckpoint({
      id: 'cp-2',
      taskId: 'task-1',
      status: 'running',
      activeModel: 'qwen3:4b',
      step: 2,
      event: 'Step 2 completed',
      workspace: '/tmp/project'
    });

    const latest2 = store.getLatestCheckpoint('task-1');
    assert.equal(latest2.id, 'cp-2');
    assert.equal(latest2.step, 2);

    const all = store.getCheckpoints('task-1');
    assert.equal(all.length, 2);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('5. deterministic checkpoint hash computation', () => {
  const data = {
    id: 'cp-fixed',
    taskId: 'task-abc',
    createdAt: '2026-09-13T10:00:00.000Z',
    status: 'running',
    activeModel: 'model-a',
    step: 3,
    event: 'Model switched',
    workspace: '/test/ws'
  };

  const hash1 = computeCheckpointHash(data);
  const hash2 = computeCheckpointHash(data);
  assert.equal(hash1, hash2);
  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 64); // SHA-256 hex string

  // Property ordering permutation must produce identical hash
  const permuted = {
    workspace: '/test/ws',
    step: 3,
    id: 'cp-fixed',
    event: 'Model switched',
    status: 'running',
    taskId: 'task-abc',
    activeModel: 'model-a',
    createdAt: '2026-09-13T10:00:00.000Z'
  };
  const hash3 = computeCheckpointHash(permuted);
  assert.equal(hash1, hash3);
});

test('6. tampered checkpoint detection fails closed', () => {
  const record = {
    id: 'cp-secure',
    taskId: 'task-xyz',
    createdAt: '2026-09-13T10:00:00.000Z',
    status: 'running',
    activeModel: 'model-1',
    step: 1,
    event: 'Started',
    workspace: '/ws'
  };

  const hash = computeCheckpointHash(record);
  const validCp = { ...record, integrityHash: hash };

  const checkValid = verifyCheckpoint(validCp);
  assert.equal(checkValid.valid, true);

  // Tamper with status
  const tamperedStatus = { ...validCp, status: 'completed' };
  const checkTampered = verifyCheckpoint(tamperedStatus);
  assert.equal(checkTampered.valid, false);
  assert.match(checkTampered.reason, /Integrity hash mismatch/);

  // Tamper with step number
  const tamperedStep = { ...validCp, step: 2 };
  assert.equal(verifyCheckpoint(tamperedStep).valid, false);

  // Missing hash
  assert.equal(verifyCheckpoint({ ...record, integrityHash: null }).valid, false);
});

test('7. valid state transitions succeed in task event log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);

    const event1 = store.recordTaskEvent({
      taskId: 'task-seq',
      previousStatus: 'queued',
      nextStatus: 'running',
      reason: 'Task execution started'
    });
    assert.equal(event1.previousStatus, 'queued');
    assert.equal(event1.nextStatus, 'running');

    const event2 = store.recordTaskEvent({
      taskId: 'task-seq',
      previousStatus: 'running',
      nextStatus: 'completed',
      reason: 'Task execution completed'
    });
    assert.equal(event2.nextStatus, 'completed');

    const events = store.getTaskEvents('task-seq');
    assert.equal(events.length, 2);
    assert.equal(events[0].nextStatus, 'running');
    assert.equal(events[1].nextStatus, 'completed');

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('8. invalid transition rejection preserves task-state rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);

    // draft -> completed is invalid
    assert.throws(
      () => store.recordTaskEvent({
        taskId: 'task-invalid',
        previousStatus: 'draft',
        nextStatus: 'completed'
      }),
      /Invalid task transition: draft → completed/
    );

    // completed -> running is invalid (terminal state)
    assert.throws(
      () => store.recordTaskEvent({
        taskId: 'task-invalid',
        previousStatus: 'completed',
        nextStatus: 'running'
      }),
      /Invalid task transition: completed → running/
    );

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('9. append-only task events recorded in chronological order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);

    store.recordTaskEvent({
      taskId: 'task-order',
      previousStatus: 'queued',
      nextStatus: 'running',
      timestamp: '2026-09-13T10:00:00.000Z',
      reason: 'Event 1'
    });

    store.recordTaskEvent({
      taskId: 'task-order',
      previousStatus: 'running',
      nextStatus: 'awaiting_approval',
      timestamp: '2026-09-13T10:01:00.000Z',
      reason: 'Event 2'
    });

    store.recordTaskEvent({
      taskId: 'task-order',
      previousStatus: 'awaiting_approval',
      nextStatus: 'running',
      timestamp: '2026-09-13T10:02:00.000Z',
      reason: 'Event 3'
    });

    const events = store.getTaskEvents('task-order');
    assert.equal(events.length, 3);
    assert.equal(events[0].previousStatus, 'queued');
    assert.equal(events[1].previousStatus, 'running');
    assert.equal(events[2].previousStatus, 'awaiting_approval');

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('10. tool action persistence and status update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);

    const action = store.recordToolAction({
      taskId: 'task-t1',
      toolName: 'read_file',
      args: { path: 'file.txt' },
      policyDecision: 'allowed',
      status: 'pending'
    });

    assert.ok(action.idempotencyKey);
    assert.equal(action.status, 'pending');

    const fetched = store.getToolAction(action.idempotencyKey);
    assert.equal(fetched.status, 'pending');
    assert.equal(fetched.toolName, 'read_file');

    // Update to success
    const updated = store.recordToolAction({
      idempotencyKey: action.idempotencyKey,
      taskId: 'task-t1',
      toolName: 'read_file',
      status: 'success',
      resultSummary: JSON.stringify({ content: 'data' }),
      finishedAt: new Date().toISOString()
    });

    assert.equal(updated.status, 'success');
    assert.equal(updated.resultSummary, JSON.stringify({ content: 'data' }));

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('11. deterministic idempotency key ignores key order and redacts secrets', () => {
  const key1 = computeToolIdempotencyKey({
    taskId: 'task-idemp',
    toolName: 'write_file',
    args: { path: 'a.txt', content: 'hello' }
  });

  const key2 = computeToolIdempotencyKey({
    taskId: 'task-idemp',
    toolName: 'write_file',
    args: { content: 'hello', path: 'a.txt' } // permuted order
  });

  assert.equal(key1, key2);

  // Canonicalization redacts secrets via one-way hash
  const clean = canonicalizeToolArgs({
    password: 'super_secret_pwd',
    apiKey: 'secret_token_123',
    normalArg: 'safe'
  });
  assert.ok(!JSON.stringify(clean).includes('super_secret_pwd'));
  assert.ok(!JSON.stringify(clean).includes('secret_token_123'));
  assert.ok(clean.password.startsWith('[REDACTED:sha256:'));
  assert.ok(clean.apiKey.startsWith('[REDACTED:sha256:'));
  assert.equal(clean.normalArg, 'safe');
});

test('12. completed-action lookup only returns successfully completed actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);

    // Pending action is not considered completed
    store.recordToolAction({
      taskId: 'task-comp',
      toolName: 'list_files',
      args: { path: '.' },
      status: 'pending'
    });

    assert.equal(store.getCompletedToolAction('task-comp', 'list_files', { path: '.' }), null);

    // Mark as success
    store.recordToolAction({
      taskId: 'task-comp',
      toolName: 'list_files',
      args: { path: '.' },
      status: 'success',
      resultSummary: '["file1.txt"]'
    });

    const completed = store.getCompletedToolAction('task-comp', 'list_files', { path: '.' });
    assert.ok(completed);
    assert.equal(completed.status, 'success');
    assert.equal(completed.resultSummary, '["file1.txt"]');

    // Failed action is not considered completed
    store.recordToolAction({
      taskId: 'task-comp',
      toolName: 'run_command',
      args: { command: 'cat', args: ['missing'] },
      status: 'failure',
      error: 'File not found'
    });

    assert.equal(
      store.getCompletedToolAction('task-comp', 'run_command', { command: 'cat', args: ['missing'] }),
      null
    );

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('13. ambiguous/in-progress and pending actions marked as needs_verification on store reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store1 = await openStore(dir);

    // Verify supported tool action statuses
    assert.deepEqual(
      TOOL_ACTION_STATUSES,
      ['pending', 'in_progress', 'success', 'failure', 'needs_verification']
    );

    // Invalid status throws
    assert.throws(
      () => store1.recordToolAction({
        taskId: 'task-crash',
        toolName: 'run_command',
        status: 'executing_unknown'
      }),
      /Invalid tool action status/
    );

    // Action A was in pending state when process stopped
    const pendingAction = store1.recordToolAction({
      taskId: 'task-crash',
      toolName: 'run_command',
      args: { command: 'node', args: ['script.js'] },
      status: 'pending'
    });

    // Action B was actively in_progress when process stopped
    const inProgressAction = store1.recordToolAction({
      taskId: 'task-crash',
      toolName: 'run_command',
      args: { command: 'node', args: ['worker.js'] },
      status: 'in_progress'
    });

    // Action C was already completed successfully
    const successAction = store1.recordToolAction({
      taskId: 'task-crash',
      toolName: 'run_command',
      args: { command: 'node', args: ['done.js'] },
      status: 'success',
      resultSummary: 'done'
    });

    // Action D had failed
    const failedAction = store1.recordToolAction({
      taskId: 'task-crash',
      toolName: 'run_command',
      args: { command: 'node', args: ['error.js'] },
      status: 'failure',
      error: 'exit 1'
    });

    store1.close();

    // Reopen store (simulating restart after crash)
    const store2 = await openStore(dir);

    // Both pending and in_progress must be marked needs_verification
    const checkedPending = store2.getToolAction(pendingAction.idempotencyKey);
    assert.ok(checkedPending);
    assert.equal(checkedPending.status, 'needs_verification');

    const checkedInProgress = store2.getToolAction(inProgressAction.idempotencyKey);
    assert.ok(checkedInProgress);
    assert.equal(checkedInProgress.status, 'needs_verification');

    // Success and failure actions remain unchanged
    const checkedSuccess = store2.getToolAction(successAction.idempotencyKey);
    assert.equal(checkedSuccess.status, 'success');

    const checkedFailure = store2.getToolAction(failedAction.idempotencyKey);
    assert.equal(checkedFailure.status, 'failure');

    // Neither pending nor in_progress should be treated as completed
    assert.equal(
      store2.getCompletedToolAction('task-crash', 'run_command', { command: 'node', args: ['script.js'] }),
      null
    );
    assert.equal(
      store2.getCompletedToolAction('task-crash', 'run_command', { command: 'node', args: ['worker.js'] }),
      null
    );

    // Success action is returned as completed
    assert.ok(
      store2.getCompletedToolAction('task-crash', 'run_command', { command: 'node', args: ['done.js'] })
    );

    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('14. restart/recovery verifies checkpoint integrity and detects corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store1 = await openStore(dir);
    const task = {
      id: 'task-recov',
      goal: 'Recovery test',
      status: 'paused',
      message: 'Paused state',
      activeModel: 'qwen3:4b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: []
    };
    store1.upsertTask(task);

    store1.recordCheckpoint({
      id: 'cp-recov-1',
      taskId: 'task-recov',
      status: 'paused',
      activeModel: 'qwen3:4b',
      step: 1,
      event: 'Task paused'
    });
    store1.close();

    // Reopen and recover valid task
    const store2 = await openStore(dir);
    const recoveryValid = store2.recoverTask('task-recov');
    assert.equal(recoveryValid.ok, true);
    assert.equal(recoveryValid.task.id, 'task-recov');
    assert.equal(recoveryValid.latestCheckpoint.id, 'cp-recov-1');

    // Directly tamper with the stored checkpoint row in SQLite (simulating disk corruption / external tampering)
    store2.database.prepare(
      'UPDATE checkpoints SET status = ? WHERE id = ?'
    ).run('tampered_status', 'cp-recov-1');

    const recoveryCorrupted = store2.recoverTask('task-recov');
    assert.equal(recoveryCorrupted.ok, false);
    assert.match(recoveryCorrupted.error, /Corrupted checkpoint integrity/);
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('15. migration compatibility with existing tasks/config JSON where still supported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const legacyTasks = [
      {
        id: 'legacy-task-1',
        goal: 'Migrated legacy task',
        status: 'queued',
        message: 'From JSON file',
        activeModel: 'qwen3:4b',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
        steps: [],
        checkpoints: [],
        switches: []
      }
    ];
    const legacyConfig = {
      preferredModel: 'legacy-model',
      maxSteps: 4
    };

    await writeFile(join(dir, 'tasks.json'), JSON.stringify(legacyTasks));
    await writeFile(join(dir, 'config.json'), JSON.stringify(legacyConfig));

    const store = await openStore(dir);
    const tasks = store.getTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'legacy-task-1');
    assert.equal(tasks[0].goal, 'Migrated legacy task');

    const config = store.getConfig();
    assert.equal(config.preferredModel, 'legacy-model');
    assert.equal(config.maxSteps, 4);

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('16. orchestrator integration records checkpoints with hashes, events, and replays completed actions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);
    const task = {
      id: 'orch-task-1',
      goal: 'Orchestrator store integration',
      status: 'queued',
      message: 'Waiting to start.',
      activeModel: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    };

    store.upsertTask(task);

    let brokerExecutions = 0;
    const orchestrator = createOrchestrator({
      getTasks: async () => store.getTasks(),
      saveTasks: async tasks => store.saveTasks(tasks),
      getConfig: async () => ({
        preferredModel: 'qwen3:4b',
        fallbacks: [],
        maxSteps: 2,
        allowedCommands: ['node']
      }),
      toolBrokerFactory: async () => ({
        execute: async () => {
          brokerExecutions++;
          return { data: 'tool_output' };
        }
      }),
      modelAdapter: async (endpoint, model, messages) => {
        // Step 0: return a tool call
        if (messages.length <= 2) {
          return {
            message: {
              content: 'Running tool',
              tool_calls: [
                {
                  id: 'call-1',
                  function: {
                    name: 'list_files',
                    arguments: { path: '.' }
                  }
                }
              ]
            }
          };
        }
        // Step 1: finish
        return {
          message: {
            content: 'All done.',
            tool_calls: []
          }
        };
      },
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    await orchestrator.runTask('orch-task-1');

    // Verify task updated and checkpoints have integrity hashes
    const updated = store.getTask('orch-task-1');
    assert.equal(updated.status, 'completed');
    assert.ok(updated.checkpoints.length >= 2);
    for (const cp of updated.checkpoints) {
      assert.ok(cp.integrityHash, 'Checkpoint must have integrityHash');
      assert.equal(verifyCheckpoint(cp).valid, true);
    }

    // Verify checkpoints were recorded in store
    const latestCp = store.getLatestCheckpoint('orch-task-1');
    assert.ok(latestCp);
    assert.equal(verifyCheckpoint(latestCp).valid, true);

    // Verify state transition events were recorded in store
    const events = store.getTaskEvents('orch-task-1');
    assert.ok(events.length >= 2);
    assert.equal(events[0].previousStatus, 'queued');
    assert.equal(events[0].nextStatus, 'running');

    // Verify tool action was recorded in ledger as success
    const completedAction = store.getCompletedToolAction('orch-task-1', 'list_files', { path: '.' });
    assert.ok(completedAction);
    assert.equal(completedAction.status, 'success');
    assert.equal(brokerExecutions, 1);

    // Deterministic replay: if orchestrator runs again with the same task and tool action,
    // it recognizes completed action and does not re-invoke the tool broker!
    const task2 = {
      id: 'orch-task-1',
      goal: 'Orchestrator store integration',
      status: 'queued',
      message: 'Waiting to start.',
      activeModel: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    };
    store.upsertTask(task2);

    await orchestrator.runTask('orch-task-1');
    // brokerExecutions must still be 1 (replayed from store ledger)
    assert.equal(brokerExecutions, 1);

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('17. supplied invalid checkpoint hash is rejected by recordCheckpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);
    assert.throws(
      () => store.recordCheckpoint({
        id: 'cp-bad',
        taskId: 'task-1',
        status: 'running',
        activeModel: 'm1',
        step: 1,
        event: 'event',
        integrityHash: 'invalid_sha256_hash_that_does_not_match'
      }),
      /Invalid checkpoint integrity hash/
    );
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('18. different secret values produce different idempotency keys without persisting plaintext', () => {
  const keyA = computeToolIdempotencyKey({
    taskId: 'task-auth',
    toolName: 'api_call',
    args: { apiKey: 'secret_token_AAA', endpoint: '/data' }
  });

  const keyB = computeToolIdempotencyKey({
    taskId: 'task-auth',
    toolName: 'api_call',
    args: { apiKey: 'secret_token_BBB', endpoint: '/data' }
  });

  // Different secret values MUST produce different idempotency keys
  assert.notEqual(keyA, keyB);

  // Same secret value produces identical idempotency key
  const keyA2 = computeToolIdempotencyKey({
    taskId: 'task-auth',
    toolName: 'api_call',
    args: { apiKey: 'secret_token_AAA', endpoint: '/data' }
  });
  assert.equal(keyA, keyA2);

  // Canonical args do not contain plaintext secrets
  const cleanA = canonicalizeToolArgs({ apiKey: 'secret_token_AAA', endpoint: '/data' });
  const serialized = JSON.stringify(cleanA);
  assert.ok(!serialized.includes('secret_token_AAA'));
  assert.ok(serialized.includes('[REDACTED:sha256:'));
});

test('19. nested secret arguments are recursively redacted and not persisted in plaintext', () => {
  const deepArgs = {
    config: {
      credentials: {
        password: 'nested_plaintext_password_xyz',
        tokens: ['token_1', 'token_2']
      }
    },
    user: 'alice'
  };

  const clean = canonicalizeToolArgs(deepArgs);
  const json = JSON.stringify(clean);

  assert.ok(!json.includes('nested_plaintext_password_xyz'));
  assert.ok(!json.includes('token_1'));
  assert.ok(!json.includes('token_2'));
  assert.ok(json.includes('[REDACTED:sha256:'));
  assert.equal(clean.user, 'alice');
});

test('20. array length and recursion depth bounds on tool arguments', () => {
  // Test array length bound (max 50)
  const hugeArray = Array.from({ length: 100 }, (_, i) => `item-${i}`);
  const cleanArray = canonicalizeToolArgs(hugeArray);
  assert.equal(cleanArray.length, 50);
  assert.equal(cleanArray[0], 'item-0');
  assert.equal(cleanArray[49], 'item-49');

  // Test recursion depth bound (max 5)
  let deeplyNested = { val: 'leaf' };
  for (let i = 0; i < 10; i++) {
    deeplyNested = { next: deeplyNested };
  }
  const cleanNested = canonicalizeToolArgs(deeplyNested);
  let cur = cleanNested;
  for (let i = 0; i < 5; i++) {
    cur = cur.next;
  }
  assert.equal(cur.next, '[TRUNCATED_DEPTH]');
});

test('21. atomic transition failure does not leave event or checkpoint ahead of task snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);
    const initialTask = {
      id: 'task-atomic-1',
      goal: 'Atomic test',
      status: 'queued',
      message: 'Init',
      activeModel: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: []
    };
    store.upsertTask(initialTask);

    // Attempt transition with invalid state transition (draft -> completed is not allowed)
    assert.throws(
      () => store.recordTaskTransition({
        task: {
          ...initialTask,
          status: 'completed',
          updatedAt: new Date().toISOString()
        },
        previousStatus: 'draft',
        nextStatus: 'completed',
        reason: 'Invalid attempt',
        checkpoint: {
          id: 'cp-should-not-exist',
          taskId: 'task-atomic-1',
          status: 'completed',
          step: 1,
          event: 'Failed checkpoint'
        }
      }),
      /Invalid task transition/
    );

    // Verify task in SQLite remains in initial state 'queued'
    const currentTask = store.getTask('task-atomic-1');
    assert.equal(currentTask.status, 'queued');

    // Verify checkpoint was NOT persisted
    const cp = store.getLatestCheckpoint('task-atomic-1');
    assert.equal(cp, null);

    // Verify event was NOT persisted
    const events = store.getTaskEvents('task-atomic-1');
    assert.equal(events.length, 0);

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('22. mid-transaction write failure rolls back task snapshot, checkpoints, and task events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  try {
    const store = await openStore(dir);
    const initialTask = {
      id: 'task-atomic-rollback',
      goal: 'Atomic rollback test',
      status: 'running',
      message: 'Initial state',
      activeModel: 'model-a',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ at: new Date().toISOString(), kind: 'start' }],
      checkpoints: []
    };

    // 1. Establish baseline persisted task with 1 checkpoint and 1 event
    store.recordTaskTransition({
      task: initialTask,
      previousStatus: 'queued',
      nextStatus: 'running',
      reason: 'Started task',
      checkpoint: {
        id: 'cp-initial',
        taskId: 'task-atomic-rollback',
        status: 'running',
        step: 1,
        event: 'Initial checkpoint'
      }
    });

    // Verify baseline state
    assert.equal(store.getTask('task-atomic-rollback').status, 'running');
    assert.equal(store.getCheckpoints('task-atomic-rollback').length, 1);
    assert.equal(store.getTaskEvents('task-atomic-rollback').length, 1);

    // 2. Attempt transition that fails after checkpoint and event writes have begun in SQLite
    assert.throws(
      () => store.recordTaskTransition({
        task: {
          ...initialTask,
          status: 'completed',
          message: 'Finished task',
          updatedAt: new Date().toISOString()
        },
        previousStatus: 'running',
        nextStatus: 'completed',
        reason: 'Task finished',
        checkpoint: {
          id: 'cp-should-rollback',
          taskId: 'task-atomic-rollback',
          status: 'completed',
          step: 2,
          event: 'Uncommitted checkpoint'
        },
        _testSeam: 'after_event'
      }),
      /Simulated failure at test seam: after_event/
    );

    // Verify EVERYTHING remains unchanged after rollback:
    // Task snapshot remains at initial state
    const taskAfterSeam1 = store.getTask('task-atomic-rollback');
    assert.equal(taskAfterSeam1.status, 'running');
    assert.equal(taskAfterSeam1.message, 'Initial state');

    // Checkpoint collection remains at baseline (1 checkpoint)
    const cpsAfterSeam1 = store.getCheckpoints('task-atomic-rollback');
    assert.equal(cpsAfterSeam1.length, 1);
    assert.equal(cpsAfterSeam1[0].id, 'cp-initial');
    assert.equal(store.getLatestCheckpoint('task-atomic-rollback').id, 'cp-initial');

    // Task events collection remains at baseline (1 event)
    const eventsAfterSeam1 = store.getTaskEvents('task-atomic-rollback');
    assert.equal(eventsAfterSeam1.length, 1);
    assert.equal(eventsAfterSeam1[0].previousStatus, 'queued');
    assert.equal(eventsAfterSeam1[0].nextStatus, 'running');

    // 3. Also test failure right before commit (after task upsert write has occurred)
    assert.throws(
      () => store.recordTaskTransition({
        task: {
          ...initialTask,
          status: 'completed',
          message: 'Another uncommitted message',
          updatedAt: new Date().toISOString()
        },
        previousStatus: 'running',
        nextStatus: 'completed',
        reason: 'Task finished 2',
        checkpoint: {
          id: 'cp-should-rollback-2',
          taskId: 'task-atomic-rollback',
          status: 'completed',
          step: 2,
          event: 'Uncommitted checkpoint 2'
        },
        _testSeam: 'before_commit'
      }),
      /Simulated failure at test seam: before_commit/
    );

    // Verify task snapshot, checkpoints, and task events still remain unchanged at baseline
    const taskAfterSeam2 = store.getTask('task-atomic-rollback');
    assert.equal(taskAfterSeam2.status, 'running');
    assert.equal(taskAfterSeam2.message, 'Initial state');

    const cpsAfterSeam2 = store.getCheckpoints('task-atomic-rollback');
    assert.equal(cpsAfterSeam2.length, 1);
    assert.equal(cpsAfterSeam2[0].id, 'cp-initial');

    const eventsAfterSeam2 = store.getTaskEvents('task-atomic-rollback');
    assert.equal(eventsAfterSeam2.length, 1);

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approval requests persist, bind exact arguments, and resolve only once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-test-'));

  try {
    const store = await openStore(dir);

    const created = store.createApprovalRequest({
      id: 'approval-1',
      taskId: 'task-approval-1',
      toolActionId: 'action-approval-1',
      toolName: 'write_file',
      args: {
        path: 'src/example.js',
        content: 'hello',
        token: 'secret-value'
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });

    assert.equal(created.id, 'approval-1');
    assert.equal(created.taskId, 'task-approval-1');
    assert.equal(created.toolActionId, 'action-approval-1');
    assert.equal(created.toolName, 'write_file');
    assert.equal(created.status, 'pending');
    assert.equal(created.args.path, 'src/example.js');
    assert.equal(created.args.content, 'hello');

    // Sensitive values must not be persisted in plaintext.
    assert.notEqual(created.args.token, 'secret-value');
    assert.match(created.args.token, /^\[REDACTED:sha256:[a-f0-9]{64}\]$/);

    // Exact replay is idempotent.
    const replay = store.createApprovalRequest({
      id: 'approval-1',
      taskId: 'task-approval-1',
      toolActionId: 'action-approval-1',
      toolName: 'write_file',
      args: {
        content: 'hello',
        token: 'secret-value',
        path: 'src/example.js'
      },
      createdAt: created.createdAt,
      expiresAt: created.expiresAt
    });

    assert.equal(replay.id, 'approval-1');
    assert.equal(replay.status, 'pending');

    // Reusing the approval ID with different bound arguments must fail closed.
    assert.throws(
      () => store.createApprovalRequest({
        id: 'approval-1',
        taskId: 'task-approval-1',
        toolActionId: 'action-approval-1',
        toolName: 'write_file',
        args: {
          path: 'src/other.js',
          content: 'hello',
          token: 'secret-value'
        },
        createdAt: '2026-09-14T10:00:00.000Z',
        expiresAt: '2026-09-14T10:05:00.000Z'
      }),
      /identity conflict/
    );

    const approved = store.resolveApprovalRequest('approval-1', {
      status: 'approved',
      resolvedAt: '2026-09-14T10:01:00.000Z',
      resolutionReason: 'User approved exact proposed change.'
    });

    assert.equal(approved.status, 'approved');
    assert.equal(approved.resolvedAt, '2026-09-14T10:01:00.000Z');
    assert.equal(
      approved.resolutionReason,
      'User approved exact proposed change.'
    );

    // A resolved approval cannot be resolved a second time.
    assert.throws(
      () => store.resolveApprovalRequest('approval-1', {
        status: 'denied'
      }),
      /already resolved/
    );

    store.close();

    // Approval survives store restart.
    const reopened = await openStore(dir);
    const recovered = reopened.getApprovalRequest('approval-1');

    assert.equal(recovered.status, 'approved');
    assert.equal(recovered.taskId, 'task-approval-1');
    assert.equal(recovered.toolActionId, 'action-approval-1');
    assert.equal(recovered.args.path, 'src/example.js');

    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approved approval requests consume exactly once and require exact binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-consume-test-'));

  try {
    const store = await openStore(dir);

    const expiresAt = new Date(
      Date.now() + 5 * 60 * 1000
    ).toISOString();

    const args = {
      path: 'src/example.js',
      content: 'approved content'
    };

    store.createApprovalRequest({
      id: 'approval-consume-1',
      taskId: 'task-consume-1',
      toolActionId: 'action-consume-1',
      toolName: 'write_file',
      args,
      expiresAt
    });

    store.resolveApprovalRequest('approval-consume-1', {
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolutionReason: 'User approved exact proposed change.'
    });

    const consumed = store.consumeApprovalRequest('approval-consume-1', {
      taskId: 'task-consume-1',
      toolActionId: 'action-consume-1',
      toolName: 'write_file',
      args: {
        content: 'approved content',
        path: 'src/example.js'
      }
    });

    assert.equal(consumed.status, 'consumed');
    assert.equal(consumed.id, 'approval-consume-1');

    // A consumed approval is single-use.
    assert.throws(
      () => store.consumeApprovalRequest('approval-consume-1', {
        taskId: 'task-consume-1',
        toolActionId: 'action-consume-1',
        toolName: 'write_file',
        args
      }),
      /not consumable with status "consumed"/
    );

    // A different task cannot consume the approval.
    const taskMismatchDir = await mkdtemp(
      join(tmpdir(), 'store-approval-consume-mismatch-')
    );

    try {
      const mismatchStore = await openStore(taskMismatchDir);

      mismatchStore.createApprovalRequest({
        id: 'approval-consume-mismatch-1',
        taskId: 'task-consume-2',
        toolActionId: 'action-consume-2',
        toolName: 'write_file',
        args,
        expiresAt
      });

      mismatchStore.resolveApprovalRequest(
        'approval-consume-mismatch-1',
        { status: 'approved' }
      );

      assert.throws(
        () => mismatchStore.consumeApprovalRequest(
          'approval-consume-mismatch-1',
          {
            taskId: 'different-task',
            toolActionId: 'action-consume-2',
            toolName: 'write_file',
            args
          }
        ),
        /task binding mismatch/
      );

      assert.throws(
        () => mismatchStore.consumeApprovalRequest(
          'approval-consume-mismatch-1',
          {
            taskId: 'task-consume-2',
            toolActionId: 'action-consume-2',
            toolName: 'write_file',
            args: {
              path: 'src/other.js',
              content: 'approved content'
            }
          }
        ),
        /argument binding mismatch/
      );

      assert.equal(
        mismatchStore.getApprovalRequest(
          'approval-consume-mismatch-1'
        ).status,
        'approved'
      );

      mismatchStore.close();
    } finally {
      await rm(taskMismatchDir, {
        recursive: true,
        force: true
      });
    }

    store.close();
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test('expired approval requests fail closed and cannot become approved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-expiry-test-'));

  try {
    const store = await openStore(dir);

    store.createApprovalRequest({
      id: 'approval-expired-1',
      taskId: 'task-expired-1',
      toolActionId: 'action-expired-1',
      toolName: 'write_file',
      args: {
        path: 'src/example.js',
        content: 'expired'
      },
      createdAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:01:00.000Z'
    });

    const resolved = store.resolveApprovalRequest('approval-expired-1', {
      status: 'approved',
      resolvedAt: '2026-09-14T10:02:00.000Z'
    });

    assert.equal(resolved.status, 'expired');
    assert.equal(
      resolved.resolutionReason,
      'Approval request expired before resolution.'
    );

    assert.throws(
      () => store.resolveApprovalRequest('approval-expired-1', {
        status: 'approved'
      }),
      /already resolved/
    );

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approval request rejects invalid resolution status and invalid expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-invalid-test-'));

  try {
    const store = await openStore(dir);

    store.createApprovalRequest({
      id: 'approval-invalid-1',
      taskId: 'task-invalid-1',
      toolActionId: 'action-invalid-1',
      toolName: 'write_file',
      args: {
        path: 'src/example.js'
      },
      createdAt: '2026-09-14T10:00:00.000Z',
      expiresAt: '2026-09-14T10:05:00.000Z'
    });

    assert.throws(
      () => store.resolveApprovalRequest('approval-invalid-1', {
        status: 'pending'
      }),
      /Invalid approval resolution status/
    );

    store.close();

    const invalidDir = await mkdtemp(join(tmpdir(), 'store-approval-invalid-expiry-'));

    try {
      const invalidStore = await openStore(invalidDir);

      invalidStore.createApprovalRequest({
        id: 'approval-invalid-expiry-1',
        taskId: 'task-invalid-expiry-1',
        toolActionId: 'action-invalid-expiry-1',
        toolName: 'write_file',
        args: {
          path: 'src/example.js'
        },
        createdAt: '2026-09-14T10:00:00.000Z',
        expiresAt: 'not-a-date'
      });

      assert.throws(
        () => invalidStore.resolveApprovalRequest('approval-invalid-expiry-1', {
          status: 'approved'
        }),
        /invalid expiration timestamp/
      );

      invalidStore.close();
    } finally {
      await rm(invalidDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approval-required mutation creates a bound approval and never executes the broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-orch-test-'));

  try {
    const store = await openStore(dir);

    const task = {
      id: 'task-approval-orch-1',
      goal: 'Test approval-gated mutation',
      status: 'queued',
      message: 'Queued',
      activeModel: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    };

    store.upsertTask(task);

    let brokerExecutions = 0;
    const emitted = [];

    const orchestrator = createOrchestrator({
      getTasks: async () => store.getTasks(),
      saveTasks: async tasks => store.saveTasks(tasks),
      getConfig: async () => ({
        provider: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        preferredModel: 'qwen3:4b',
        fallbacks: [],
        maxSteps: 2,
        allowedCommands: [],
        networkToolsEnabled: false,
        allowWrites: true
      }),
      toolBrokerFactory: async () => ({
        execute: async () => {
          brokerExecutions++;
          return { data: 'MUST NOT EXECUTE' };
        }
      }),
      modelAdapter: async () => ({
        message: {
          content: 'I want to modify the file.',
          tool_calls: [
            {
              id: 'approval-call-1',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: {
                  path: 'src/approved-example.js',
                  content: 'approved content'
                }
              }
            }
          ]
        }
      }),
      toolSpec: [],
      projectRoot: dir,
      emit: (type, payload) => {
        emitted.push({ type, payload });
      },
      store
    });

    await orchestrator.runTask(task.id);

    const updated = store.getTask(task.id);

    assert.equal(updated.status, 'awaiting_approval');
    assert.match(updated.message, /Approval required for write_file/);

    assert.equal(brokerExecutions, 0);

    const approval = store.getApprovalRequestByToolAction(
      store.database
        .prepare(`
          SELECT id
          FROM tool_actions
          WHERE task_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        `)
        .get(task.id).id
    );

    assert.ok(approval);
    assert.equal(approval.taskId, task.id);
    assert.equal(approval.toolName, 'write_file');
    assert.equal(approval.status, 'pending');
    assert.equal(approval.args.path, 'src/approved-example.js');
    assert.equal(approval.args.content, 'approved content');

    const action = store.database
      .prepare(`
        SELECT tool_name, policy_decision, status
        FROM tool_actions
        WHERE task_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `)
      .get(task.id);

    assert.equal(action.tool_name, 'write_file');
    assert.equal(action.policy_decision, 'requires_approval');
    assert.equal(action.status, 'pending');

    assert.ok(
      emitted.some(event =>
        event.type === 'approval_required' &&
        event.payload?.taskId === task.id &&
        event.payload?.approvalId === approval.id
      )
    );

    assert.equal(
      updated.steps.some(step => step.kind === 'approval_required'),
      true
    );

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approval consumption fails at the database boundary when approval expires between validation and update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-expiry-race-test-'));

  try {
    const store = await openStore(dir);

    const taskId = 'task-approval-expiry-race';
    const toolActionId = 'action-approval-expiry-race';

    const approval = store.createApprovalRequest({
      id: 'approval-expiry-race-1',
      taskId,
      toolActionId,
      toolName: 'write_file',
      args: {
        path: 'src/race.js',
        content: 'race'
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    store.resolveApprovalRequest(approval.id, {
      status: 'approved'
    });

    const approved = store.getApprovalRequest(approval.id);
    assert.equal(approved.status, 'approved');

    store.database.prepare(`
      UPDATE approval_requests
      SET expires_at = ?
      WHERE id = ?
    `).run(
      new Date(Date.now() - 1_000).toISOString(),
      approval.id
    );

    assert.throws(
      () =>
        store.consumeApprovalRequest(approval.id, {
          taskId,
          toolActionId,
          toolName: 'write_file',
          args: {
            path: 'src/race.js',
            content: 'race'
          }
        }),
      /expired|consumption failed|not consumable/i
    );

    const after = store.getApprovalRequest(approval.id);

    assert.equal(after.status, 'approved');

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approved approval execution must use the exact persisted tool action and consume only after durable success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-execution-test-'));

  try {
    const store = await openStore(dir);

    const taskId = 'task-approval-execution-1';
    const toolActionId = 'action-approval-execution-1';

    const action = store.recordToolAction({
      id: toolActionId,
      taskId,
      toolName: 'write_file',
      args: {
        path: 'src/exact-approved.js',
        content: 'approved exact content'
      },
      policyDecision: 'requires_approval',
      status: 'pending',
      startedAt: new Date().toISOString()
    });

    const approval = store.createApprovalRequest({
      id: 'approval-execution-1',
      taskId,
      toolActionId: action.id,
      toolName: action.toolName,
      args: action.args,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    store.resolveApprovalRequest(approval.id, {
      status: 'approved'
    });

    const approved = store.getApprovalRequest(approval.id);

    assert.equal(approved.status, 'approved');
    assert.equal(approved.toolActionId, action.id);
    assert.equal(approved.toolName, 'write_file');
    assert.equal(approved.args.path, 'src/exact-approved.js');
    assert.equal(approved.args.content, 'approved exact content');

    const persistedAction = store.getToolAction(action.id);

    assert.ok(persistedAction);
    assert.equal(persistedAction.taskId, taskId);
    assert.equal(persistedAction.toolName, 'write_file');
    assert.equal(persistedAction.status, 'pending');
    assert.equal(persistedAction.args.path, 'src/exact-approved.js');
    assert.equal(
      persistedAction.args.content,
      'approved exact content'
    );

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approved mutation executes the persisted action once and replay never executes it twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-approval-execution-orch-test-'));

  try {
    const store = await openStore(dir);

    const task = {
      id: 'task-approval-execution-orch-1',
      goal: 'Execute approved mutation',
      status: 'awaiting_approval',
      message: 'Approval required for write_file.',
      activeModel: 'qwen3:4b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    };

    store.upsertTask(task);

    const action = store.recordToolAction({
      id: 'action-approval-execution-orch-1',
      taskId: task.id,
      toolName: 'write_file',
      args: {
        path: 'src/exact-approved.js',
        content: 'approved exact content'
      },
      policyDecision: 'requires_approval',
      status: 'pending',
      startedAt: new Date().toISOString()
    });

    const approval = store.createApprovalRequest({
      id: 'approval-execution-orch-1',
      taskId: task.id,
      toolActionId: action.id,
      toolName: action.toolName,
      args: action.args,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    store.resolveApprovalRequest(approval.id, {
      status: 'approved'
    });

    let brokerExecutions = 0;
    let receivedCall = null;

    const orchestrator = createOrchestrator({
      getTasks: async () => store.getTasks(),
      saveTasks: async tasks => store.saveTasks(tasks),
      getConfig: async () => ({
        provider: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        preferredModel: 'qwen3:4b',
        fallbacks: [],
        maxSteps: 2,
        allowedCommands: [],
        networkToolsEnabled: false,
        allowWrites: true
      }),
      toolBrokerFactory: async () => ({
        execute: async call => {
          brokerExecutions++;
          receivedCall = call;

          return {
            ok: true,
            path: call.function.arguments.path
          };
        }
      }),
      modelAdapter: async () => ({
        message: {
          content: 'No further model action.',
          tool_calls: []
        }
      }),
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    assert.equal(
      typeof orchestrator.executeApprovedAction,
      'function',
      'orchestrator must expose executeApprovedAction for the approval workflow'
    );

    const first = await orchestrator.executeApprovedAction(approval.id);

    assert.equal(first.ok, true);
    assert.equal(brokerExecutions, 1);

    assert.equal(receivedCall.function.name, 'write_file');
    assert.equal(
      receivedCall.function.arguments.path,
      'src/exact-approved.js'
    );
    assert.equal(
      receivedCall.function.arguments.content,
      'approved exact content'
    );

    const completed = store.getToolAction(action.id);

    assert.equal(completed.status, 'success');

    const consumed = store.getApprovalRequest(approval.id);

    assert.equal(consumed.status, 'consumed');

    const second = await orchestrator.executeApprovedAction(approval.id);

    assert.equal(second.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(brokerExecutions, 1);

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
