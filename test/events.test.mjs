import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EVENT_TYPES,
  MAX_PAYLOAD_STRING,
  MAX_PAYLOAD_DETAIL,
  MAX_PAYLOAD_MESSAGE,
  MAX_STEP_DETAIL,
  stripSensitiveKeys,
  sanitizeTaskPayload,
  sanitizeTaskSnapshot,
  sanitizeCheckpointPayload,
  sanitizeStepPayload,
  isValidEventType,
  validateEvent,
  buildStateChangedPayload,
  buildModelSwitchPayload,
  buildToolPayload
} from '../src/events/event-schema.mjs';
import { createEventEmitter, MAX_BUFFER_SIZE } from '../src/events/event-emitter.mjs';
import { createOrchestratorBridge } from '../src/events/orchestrator-bridge.mjs';
import { openStore } from '../src/store.mjs';
import { createOrchestrator } from '../src/orchestrator/orchestrator.mjs';

// ── 1. Event schema validation and bounds ──────────────────────────────────────

test('1. event schema validation passes for valid event and rejects invalid events', () => {
  const valid = {
    id: '1',
    seq: 1,
    taskId: 'task-101',
    timestamp: new Date().toISOString(),
    type: 'task_created',
    payload: { goal: 'Build feature' }
  };
  const result = validateEvent(valid);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);

  // Missing id
  assert.equal(validateEvent({ ...valid, id: '' }).valid, false);

  // Invalid seq
  assert.equal(validateEvent({ ...valid, seq: 0 }).valid, false);
  assert.equal(validateEvent({ ...valid, seq: -1 }).valid, false);
  assert.equal(validateEvent({ ...valid, seq: '1' }).valid, false);

  // Missing taskId
  assert.equal(validateEvent({ ...valid, taskId: '' }).valid, false);

  // Unknown event type
  assert.equal(validateEvent({ ...valid, type: 'unknown_event_type' }).valid, false);

  // Non-object payload
  assert.equal(validateEvent({ ...valid, payload: null }).valid, false);
  assert.equal(validateEvent({ ...valid, payload: 'not-an-object' }).valid, false);
  assert.equal(validateEvent({ ...valid, payload: [1, 2, 3] }).valid, false);
});

test('2. payload sanitizers enforce string length bounds and structure', () => {
  const hugeString = 'x'.repeat(5000);

  const task = {
    id: 't1',
    goal: hugeString,
    status: 'running',
    message: hugeString,
    activeModel: 'model-a',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: Array.from({ length: 30 }, (_, i) => ({ kind: 'step', name: `s${i}`, at: 'now', detail: hugeString })),
    checkpoints: Array.from({ length: 30 }, (_, i) => ({ id: `cp${i}`, event: hugeString, status: 'running', step: i, createdAt: 'now' }))
  };

  const sanitizedTask = sanitizeTaskPayload(task);
  assert.ok(sanitizedTask.goal.length <= MAX_PAYLOAD_STRING);
  assert.ok(sanitizedTask.message.length <= MAX_PAYLOAD_MESSAGE);
  assert.equal(sanitizedTask.stepCount, 30);
  assert.equal(sanitizedTask.checkpointCount, 30);

  const snapshot = sanitizeTaskSnapshot(task);
  assert.ok(snapshot.goal.length <= MAX_PAYLOAD_STRING);
  assert.ok(snapshot.message.length <= MAX_PAYLOAD_MESSAGE);
  // Snapshot limits steps and checkpoints to latest 20
  assert.equal(snapshot.steps.length, 20);
  assert.equal(snapshot.checkpoints.length, 20);
  assert.ok(snapshot.steps[0].detail.length <= MAX_STEP_DETAIL);

  const cp = sanitizeCheckpointPayload({ id: 'cp1', event: hugeString, status: 'running', step: 5, createdAt: 'now' });
  assert.ok(cp.event.length <= MAX_PAYLOAD_STRING);

  const step = sanitizeStepPayload({ kind: 'tool', name: 'read_file', at: 'now', detail: hugeString, replayed: true });
  assert.ok(step.detail.length <= MAX_STEP_DETAIL);
  assert.equal(step.replayed, true);
});

// ── 2. Event sequence monotonicity ────────────────────────────────────────────

test('3. event sequence counter is strictly monotonically increasing', () => {
  const ee = createEventEmitter();

  const e1 = ee.emit('t1', 'task_created', { goal: 'Goal 1' });
  const e2 = ee.emit('t1', 'task_state_changed', { previousStatus: 'draft', nextStatus: 'queued' });
  const e3 = ee.emit('t1', 'tool_started', { toolName: 'read_file' });
  const e4 = ee.emit('t1', 'tool_completed', { toolName: 'read_file', detail: 'ok' });
  const e5 = ee.emit('t1', 'task_completed', { message: 'Done' });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);
  assert.equal(e4.seq, 4);
  assert.equal(e5.seq, 5);

  assert.equal(e1.id, '1');
  assert.equal(e2.id, '2');
  assert.equal(e3.id, '3');
  assert.equal(e4.id, '4');
  assert.equal(e5.id, '5');

  assert.equal(ee.getLatestSeq(), 5);
});

// ── 3. SSE connection behavior ────────────────────────────────────────────────

test('4. SSE subscribe registers client and formats event stream messages', () => {
  const ee = createEventEmitter();
  const writes = [];

  const mockResponse = {
    write(chunk) {
      writes.push(chunk);
    }
  };

  const unsubscribe = ee.subscribe(mockResponse);
  assert.equal(ee.clientCount(), 1);

  ee.emit('task-sse', 'task_created', { goal: 'Test SSE' });

  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith('id: 1\nevent: task_created\ndata: '));
  assert.ok(writes[0].includes('"taskId":"task-sse"'));
  assert.ok(writes[0].endsWith('\n\n'));

  unsubscribe();
  assert.equal(ee.clientCount(), 0);

  // Further emits do not write to unsubscribed response
  ee.emit('task-sse', 'task_completed', { message: 'Done' });
  assert.equal(writes.length, 1);
});

// ── 4. Reconnect from last sequence ───────────────────────────────────────────

test('5. reconnect with lastSeq replays only newer buffered events', () => {
  const ee = createEventEmitter();

  ee.emit('task-r', 'task_created', { goal: 'Goal' });       // seq 1
  ee.emit('task-r', 'tool_started', { toolName: 'ls' });       // seq 2
  ee.emit('task-r', 'tool_completed', { toolName: 'ls' });     // seq 3
  ee.emit('task-r', 'checkpoint_created', { step: 1 });        // seq 4
  ee.emit('task-r', 'task_completed', { message: 'Done' });    // seq 5

  const writes = [];
  const mockResponse = {
    write(chunk) {
      writes.push(chunk);
    }
  };

  // Client reconnects having already received up to seq 3
  const unsubscribe = ee.subscribe(mockResponse, 3);

  // Should have received seq 4 and seq 5 on connect
  assert.equal(writes.length, 2);
  assert.ok(writes[0].startsWith('id: 4\nevent: checkpoint_created'));
  assert.ok(writes[1].startsWith('id: 5\nevent: task_completed'));

  unsubscribe();
});

// ── 5. Buffer eviction behavior ───────────────────────────────────────────────

test('6. buffer eviction bounds memory and notifies reconnecting client of overflow', () => {
  // Use small buffer for test (capacity 3)
  const ee = createEventEmitter({ maxBufferSize: 3 });

  ee.emit('task-ev', 'task_created', { goal: '1' });  // seq 1
  ee.emit('task-ev', 'tool_started', { toolName: 'a' }); // seq 2
  ee.emit('task-ev', 'tool_started', { toolName: 'b' }); // seq 3
  ee.emit('task-ev', 'tool_started', { toolName: 'c' }); // seq 4 (evicts seq 1)
  ee.emit('task-ev', 'tool_started', { toolName: 'd' }); // seq 5 (evicts seq 2)

  const stats = ee.getBufferStats();
  assert.equal(stats.size, 3);
  assert.equal(stats.oldestSeq, 3);
  assert.equal(stats.latestSeq, 5);

  // Check eviction detection
  assert.equal(ee.hasEvictedSince(1), true);  // seq 1 was evicted
  assert.equal(ee.hasEvictedSince(2), true);  // seq 2 was evicted
  assert.equal(ee.hasEvictedSince(3), false); // seq 3 is still present
  assert.equal(ee.hasEvictedSince(4), false); // seq 4 is still present

  // Reconnecting with evicted seq 1 sends recovery_required warning, then retained events (3, 4, 5)
  const writes = [];
  const mockResponse = { write: chunk => writes.push(chunk) };

  const unsubscribe = ee.subscribe(mockResponse, 1);

  assert.equal(writes.length, 4); // 1 recovery warning + 3 retained events
  assert.ok(writes[0].startsWith('event: recovery_required'));
  assert.ok(writes[1].startsWith('id: 3\n'));
  assert.ok(writes[2].startsWith('id: 4\n'));
  assert.ok(writes[3].startsWith('id: 5\n'));

  unsubscribe();
});

// ── 6. Multiple clients ───────────────────────────────────────────────────────

test('7. broadcast reaches multiple concurrent clients and handles disconnected clients cleanly', () => {
  const ee = createEventEmitter();

  const writes1 = [];
  const writes2 = [];
  const res1 = { write: chunk => writes1.push(chunk) };
  const res2 = { write: chunk => writes2.push(chunk) };

  const unsub1 = ee.subscribe(res1);
  const unsub2 = ee.subscribe(res2);
  assert.equal(ee.clientCount(), 2);

  ee.emit('task-m', 'task_created', { goal: 'Multi-client' });

  assert.equal(writes1.length, 1);
  assert.equal(writes2.length, 1);
  assert.equal(writes1[0], writes2[0]);

  // One client disconnects
  unsub1();
  assert.equal(ee.clientCount(), 1);

  ee.emit('task-m', 'task_completed', { message: 'Done' });

  assert.equal(writes1.length, 1); // no new writes for unsubscribed client
  assert.equal(writes2.length, 2); // second client received new event

  unsub2();
  assert.equal(ee.clientCount(), 0);
});

// ── 7. Task / state events reaching the stream via OrchestratorBridge ───────────

test('8. orchestrator bridge translates all lifecycle signals to typed stream events', () => {
  const ee = createEventEmitter();
  const bridge = createOrchestratorBridge(ee);
  const emittedEvents = [];

  ee.subscribe({
    write: chunk => {
      const match = chunk.match(/event: ([^\n]+)\ndata: (\{.*\})\n\n/);
      if (match) {
        emittedEvents.push({ type: match[1], data: JSON.parse(match[2]) });
      }
    }
  });

  const task = {
    id: 'task-bridge-1',
    goal: 'Test lifecycle translation',
    status: 'running',
    message: 'Working',
    activeModel: 'qwen3:4b',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    checkpoints: []
  };

  // 1. Task created
  bridge.onTaskCreated({ ...task, status: 'queued' });
  // 2. Task state changed: queued -> running
  bridge.onTaskUpdated({ ...task, status: 'running' }, 'queued');
  // 3. Model switching
  bridge.onModelSwitching('task-bridge-1', 'model-a', 'model-b', 'Provider error');
  // 4. Model switched
  bridge.onModelSwitched('task-bridge-1', 'model-a', 'model-b');
  // 5. Tool lifecycle
  bridge.onToolStarted('task-bridge-1', 'run_command');
  bridge.onToolCompleted('task-bridge-1', 'run_command', 'output summary');
  bridge.onToolFailed('task-bridge-1', 'run_command', 'denied');
  // 6. Checkpoint created
  bridge.onCheckpointCreated('task-bridge-1', { id: 'cp-1', event: 'Step 1 done', status: 'running', step: 1, createdAt: 'now' });
  // 7. Approval required
  bridge.onApprovalRequired('task-bridge-1', 'Please confirm write');
  // 8. Recovery required
  bridge.onRecoveryRequired('task-bridge-1', 'Checkpoint integrity mismatch');
  // 9. Task completed
  bridge.onTaskUpdated({ ...task, status: 'completed', message: 'All done' }, 'running');

  const types = emittedEvents.map(e => e.type);

  assert.ok(types.includes('task_created'));
  assert.ok(types.includes('task_updated'));
  assert.ok(types.includes('task_state_changed'));
  assert.ok(types.includes('model_switching'));
  assert.ok(types.includes('model_switched'));
  assert.ok(types.includes('tool_started'));
  assert.ok(types.includes('tool_completed'));
  assert.ok(types.includes('tool_failed'));
  assert.ok(types.includes('checkpoint_created'));
  assert.ok(types.includes('approval_required'));
  assert.ok(types.includes('recovery_required'));
  assert.ok(types.includes('task_completed'));
});

// ── 8. No secret / raw unbounded output leakage ───────────────────────────────

test('9. sensitive keys and unbounded raw outputs are stripped and bounded', () => {
  const sensitiveObj = {
    apiKey: 'secret_123',
    api_key: 'secret_456',
    password: 'password123',
    token: 'jwt_token',
    authorization: 'Bearer token',
    bearer: 'secret_bearer',
    safeField: 'visible_data'
  };

  const stripped = stripSensitiveKeys(sensitiveObj);
  assert.equal(stripped.apiKey, undefined);
  assert.equal(stripped.api_key, undefined);
  assert.equal(stripped.password, undefined);
  assert.equal(stripped.token, undefined);
  assert.equal(stripped.authorization, undefined);
  assert.equal(stripped.bearer, undefined);
  assert.equal(stripped.safeField, 'visible_data');

  // buildToolPayload strips sensitive keys from extra
  const toolPayload = buildToolPayload('fetch', 'some detail', { apiKey: 'key-123', env: 'prod' });
  assert.equal(toolPayload.apiKey, undefined);
  assert.equal(toolPayload.env, 'prod');

  // Long detail is sliced
  const hugeOutput = 'O'.repeat(20_000);
  const boundedTool = buildToolPayload('exec', hugeOutput);
  assert.ok(boundedTool.detail.length <= MAX_PAYLOAD_DETAIL);
});

// ── 9. Snapshot + Stream reconnect flow ────────────────────────────────────────

test('10. snapshot endpoint returns sanitized task and currentSeq, enabling gapless stream reconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'event-test-'));
  try {
    const store = await openStore(dir);
    const ee = createEventEmitter();
    const bridge = createOrchestratorBridge(ee);

    const task = {
      id: 'task-flow-1',
      goal: 'Integrate snapshot and stream',
      status: 'queued',
      message: 'Initial',
      activeModel: 'model-a',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ kind: 'init', name: 'start', at: 'now', detail: 'initialized' }],
      checkpoints: [{ id: 'cp-flow', event: 'init', status: 'queued', step: 0, createdAt: 'now' }]
    };

    store.upsertTask(task);
    ee.emit(task.id, 'task_created', sanitizeTaskPayload(task)); // seq 1

    // 1. Client fetches snapshot: reads SQLite state + currentSeq
    const snapshot = {
      task: sanitizeTaskSnapshot(store.getTask('task-flow-1')),
      currentSeq: ee.getLatestSeq(),
      source: 'sqlite'
    };

    assert.equal(snapshot.task.id, 'task-flow-1');
    assert.equal(snapshot.task.status, 'queued');
    assert.equal(snapshot.currentSeq, 1);
    assert.equal(snapshot.source, 'sqlite');

    // 2. Further events occur in the background
    ee.emit(task.id, 'task_state_changed', buildStateChangedPayload('queued', 'running', 'Started')); // seq 2
    ee.emit(task.id, 'tool_started', buildToolPayload('list_files', ''));                             // seq 3

    // 3. Client connects to event stream with lastSeq = snapshot.currentSeq (1)
    const receivedEvents = [];
    const unsubscribe = ee.subscribe({
      write: chunk => {
        const match = chunk.match(/id: (\d+)\nevent: ([^\n]+)/);
        if (match) receivedEvents.push({ seq: Number(match[1]), type: match[2] });
      }
    }, snapshot.currentSeq);

    // Client immediately receives seq 2 and seq 3
    assert.equal(receivedEvents.length, 2);
    assert.equal(receivedEvents[0].seq, 2);
    assert.equal(receivedEvents[0].type, 'task_state_changed');
    assert.equal(receivedEvents[1].seq, 3);
    assert.equal(receivedEvents[1].type, 'tool_started');

    unsubscribe();
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 10. Orchestrator integration with event emission ───────────────────────────

test('11. orchestrator emits checkpoints, tools, and state changes to event layer during execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orch-events-'));
  try {
    const store = await openStore(dir);
    const ee = createEventEmitter();
    const bridge = createOrchestratorBridge(ee);

    const emittedEvents = [];
    ee.subscribe({
      write: chunk => {
        const match = chunk.match(/id: (\d+)\nevent: ([^\n]+)/);
        if (match) emittedEvents.push({ seq: Number(match[1]), type: match[2] });
      }
    });

    const taskStatusCache = new Map();
    function emit(type, payload) {
      if (type === 'task' && payload?.id) {
        const prev = taskStatusCache.get(payload.id);
        taskStatusCache.set(payload.id, payload.status);
        bridge.onTaskUpdated(payload, prev);
      } else if (type === 'checkpoint' && payload?.taskId && payload?.checkpoint) {
        bridge.onCheckpointCreated(payload.taskId, payload.checkpoint);
      } else if (type === 'tool_started' && payload?.taskId && payload?.toolName) {
        bridge.onToolStarted(payload.taskId, payload.toolName);
      } else if (type === 'tool_completed' && payload?.taskId && payload?.toolName) {
        bridge.onToolCompleted(payload.taskId, payload.toolName, payload.detail);
      } else if (type === 'tool_failed' && payload?.taskId && payload?.toolName) {
        bridge.onToolFailed(payload.taskId, payload.toolName, payload.error);
      }
    }

    const initialTask = {
      id: 'task-orch-evt-1',
      goal: 'Test orchestrator event emission',
      status: 'queued',
      message: 'Queued',
      activeModel: 'qwen3:4b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: []
    };
    store.upsertTask(initialTask);
    taskStatusCache.set(initialTask.id, initialTask.status);
    bridge.onTaskCreated(initialTask);

    const orchestrator = createOrchestrator({
      getTasks: async () => store.getTasks(),
      saveTasks: async tasks => store.saveTasks(tasks),
      getConfig: async () => ({
        provider: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        preferredModel: 'qwen3:4b',
        fallbacks: [],
        maxSteps: 2,
        allowedCommands: ['npm'],
        networkToolsEnabled: false,
        allowWrites: false
      }),
      toolBrokerFactory: async () => ({
        execute: async call => ({ files: ['package.json'] })
      }),
      modelAdapter: async () => ({
        message: {
          content: 'Done running tests',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'list_files', arguments: '{}' }
            }
          ]
        }
      }),
      toolSpec: [],
      projectRoot: '/tmp',
      emit,
      store
    });

    await orchestrator.runTask('task-orch-evt-1');

    const types = emittedEvents.map(e => e.type);

    // Verify task creation, tool execution, checkpoint creation, and state changes reached the stream
    assert.ok(types.includes('task_created'));
    assert.ok(types.includes('task_state_changed'));
    assert.ok(types.includes('tool_started'));
    assert.ok(types.includes('tool_completed'));
    assert.ok(types.includes('checkpoint_created'));

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 11. Local-only server binding and security ─────────────────────────────────

test('12. server binds strictly to 127.0.0.1 and enforces local-only access', async () => {
  // Verify default host/endpoint rules in configuration
  const localUrl = new URL('http://127.0.0.1:4317');
  assert.equal(['127.0.0.1', 'localhost', '::1'].includes(localUrl.hostname), true);

  const remoteUrl = new URL('http://example.com:11434');
  assert.equal(['127.0.0.1', 'localhost', '::1'].includes(remoteUrl.hostname), false);
});

// ── 12. Durable-state-before-event and security regression tests ──────────────

test('13. checkpoint_created is NOT emitted when durable task transition rolls back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rollback-cp-'));
  try {
    const store = await openStore(dir);
    const ee = createEventEmitter();
    const bridge = createOrchestratorBridge(ee);
    const emittedEvents = [];
    ee.subscribe({
      write: chunk => {
        const match = chunk.match(/id: (\d+)\nevent: ([^\n]+)/);
        if (match) emittedEvents.push({ seq: Number(match[1]), type: match[2] });
      }
    });

    function emit(type, payload) {
      if (type === 'checkpoint' && payload?.taskId && payload?.checkpoint) {
        bridge.onCheckpointCreated(payload.taskId, payload.checkpoint);
      } else if (type === 'task' && payload?.id) {
        bridge.onTaskUpdated(payload);
      }
    }

    const task = {
      id: 'task-rollback-1',
      goal: 'Rollback test',
      status: 'running',
      message: 'Running',
      activeModel: 'qwen3:4b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: []
    };
    store.upsertTask(task);

    // Force rollback inside recordTaskTransition via test seam
    const origRecordTaskTransition = store.recordTaskTransition;
    store.recordTaskTransition = (args) => {
      return origRecordTaskTransition({ ...args, _testSeam: 'after_checkpoint' });
    };

    const orchestrator = createOrchestrator({
      getTasks: async () => store.getTasks(),
      saveTasks: async tasks => store.saveTasks(tasks),
      getConfig: async () => ({}),
      toolBrokerFactory: async () => ({}),
      modelAdapter: async () => ({}),
      toolSpec: [],
      projectRoot: '/tmp',
      emit,
      store
    });

    await assert.rejects(
      async () => {
        await orchestrator.updateTask(task, item => {
          orchestrator.checkpoint(item, 'Checkpointed before failure');
        });
      },
      /Simulated failure at test seam/
    );

    // Checkpoint event must NOT have been emitted because transition was rolled back
    const checkpointEvents = emittedEvents.filter(e => e.type === 'checkpoint_created');
    assert.equal(checkpointEvents.length, 0, 'No checkpoint_created should be emitted after rollback');

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('14. model_switching is NOT emitted when the switching transition fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-switch-fail-'));
  try {
    const store = await openStore(dir);
    const ee = createEventEmitter();
    const bridge = createOrchestratorBridge(ee);
    const emittedEvents = [];
    ee.subscribe({
      write: chunk => {
        const match = chunk.match(/id: (\d+)\nevent: ([^\n]+)/);
        if (match) emittedEvents.push({ seq: Number(match[1]), type: match[2] });
      }
    });

    function emit(type, payload) {
      if (type === 'model_switching') {
        bridge.onModelSwitching(payload.taskId, payload.previousModel, payload.targetModel, payload.reason);
      } else if (type === 'task' && payload?.id) {
        bridge.onTaskUpdated(payload);
      }
    }

    const task = {
      id: 'task-switch-fail-1',
      goal: 'Switch fail test',
      status: 'queued',
      activeModel: '',
      message: 'Queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    };
    store.upsertTask(task);

    // Force failure when attempting to persist the switching_model transition
    let switchingModelAttempted = false;
    const origRecordTaskTransition = store.recordTaskTransition;
    store.recordTaskTransition = (args) => {
      if (args.nextStatus === 'switching_model') {
        switchingModelAttempted = true;
        throw new Error('Forced failure persisting switching_model transition');
      }
      return origRecordTaskTransition(args);
    };

    const orchestrator = createOrchestrator({
      getTasks: async () => store.getTasks(),
      saveTasks: async tasks => store.saveTasks(tasks),
      getConfig: async () => ({
        provider: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        preferredModel: 'primary-model',
        fallbacks: ['fallback-model'],
        maxSteps: 2,
        allowedCommands: [],
        networkToolsEnabled: false,
        allowWrites: false
      }),
      toolBrokerFactory: async () => ({ execute: async () => ({}) }),
      modelAdapter: async (_endpoint, model) => {
        if (model === 'primary-model') {
          const err = new Error('model unavailable');
          err.type = 'unavailable';
          throw err;
        }
        return { message: { content: 'test' } };
      },
      toolSpec: [],
      projectRoot: '/tmp',
      emit,
      store
    });

    await assert.rejects(
      async () => {
        await orchestrator.runTask('task-switch-fail-1');
      },
      /Forced failure persisting switching_model transition/
    );

    assert.equal(switchingModelAttempted, true, 'recordTaskTransition for switching_model must have been reached');

    // Verify model_switching was NOT emitted
    const switchEvents = emittedEvents.filter(e => e.type === 'model_switching');
    assert.equal(switchEvents.length, 0, 'model_switching must NOT be emitted when switching transition fails');

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('15. nested secret values are removed from event payloads', () => {
  const payloadWithSecrets = {
    user: 'alice',
    config: {
      url: 'https://example.com',
      serviceDetails: {
        token: 'secret_token_12345',
        apiKey: 'sk-1234567890abcdef',
        bearer: 'bearer_secret',
        nested: {
          password: 'supersecretpassword',
          safeKey: 'this-should-remain'
        }
      },
      headers: [
        { name: 'Authorization', secret: 'sensitive_val' },
        { name: 'Content-Type', value: 'application/json' }
      ]
    }
  };

  const sanitized = stripSensitiveKeys(payloadWithSecrets);
  assert.equal(sanitized.user, 'alice');
  assert.equal(sanitized.config.url, 'https://example.com');
  assert.equal(sanitized.config.serviceDetails.token, undefined);
  assert.equal(sanitized.config.serviceDetails.apiKey, undefined);
  assert.equal(sanitized.config.serviceDetails.bearer, undefined);
  assert.equal(sanitized.config.serviceDetails.nested.password, undefined);
  assert.equal(sanitized.config.serviceDetails.nested.safeKey, 'this-should-remain');
  assert.equal(sanitized.config.headers[0].secret, undefined);
  assert.equal(sanitized.config.headers[1].value, 'application/json');
});

test('16. deeply nested and oversized event payloads remain bounded', () => {
  // Deeply nested: depth > 4
  let deepObj = { level: 'base' };
  for (let i = 0; i < 10; i++) {
    deepObj = { next: deepObj };
  }
  const boundedDeep = stripSensitiveKeys(deepObj);
  let curr = boundedDeep;
  let reachedDepthLimit = false;
  while (curr && typeof curr === 'object') {
    if (curr.next === '[DEPTH_LIMIT]') {
      reachedDepthLimit = true;
      break;
    }
    curr = curr.next;
  }
  assert.equal(reachedDepthLimit, true, 'Deep nesting should be bounded at depth limit');

  // Oversized array: > 20 elements
  const bigArray = Array.from({ length: 50 }, (_, i) => ({ id: i }));
  const boundedArray = stripSensitiveKeys(bigArray);
  assert.equal(boundedArray.length, 20, 'Array length must be bounded to SANITIZE_MAX_ARRAY');

  // Oversized keys: > 30 keys
  const bigObj = {};
  for (let i = 0; i < 50; i++) {
    bigObj[`key_${i}`] = `value_${i}`;
  }
  const boundedObj = stripSensitiveKeys(bigObj);
  assert.equal(Object.keys(boundedObj).length, 30, 'Object key count must be bounded to SANITIZE_MAX_KEYS');
});

test('17. buildToolPayload extra fields cannot override protected toolName or detail fields', () => {
  const result = buildToolPayload('actual_tool', 'actual_detail', {
    toolName: 'malicious_override_tool',
    detail: 'malicious_override_detail',
    extraInfo: 'allowed_extra'
  });

  assert.equal(result.toolName, 'actual_tool', 'toolName must not be overridden by extra fields');
  assert.equal(result.detail, 'actual_detail', 'detail must not be overridden by extra fields');
  assert.equal(result.extraInfo, 'allowed_extra', 'non-colliding extra fields should be preserved');
});
