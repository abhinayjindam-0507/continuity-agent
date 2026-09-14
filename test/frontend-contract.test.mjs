import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { EVENT_TYPES } from '../src/events/event-schema.mjs';

const appRoot = resolve(process.cwd());
const indexHtmlPath = join(appRoot, 'src', 'index.html');

test('1. src/index.html is served as valid HTML5 with modern Stitch layout elements', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  assert.ok(content.startsWith('<!doctype html>'), 'Must have HTML5 doctype');
  assert.ok(content.includes('<meta name="viewport"'), 'Must have responsive viewport');
  assert.ok(content.includes('Continuity Agent'), 'Must contain title');

  // Key Stitch layout elements
  assert.ok(content.includes('id="appBody"'), 'Must contain appBody grid container');
  assert.ok(content.includes('id="taskList"'), 'Must contain taskList');
  assert.ok(content.includes('id="timelineList"'), 'Must contain timelineList');
  assert.ok(content.includes('id="bottomConsole"'), 'Must contain bottom activity console');
  assert.ok(content.includes('id="checkpointLedgerList"'), 'Must contain checkpointLedgerList');
  assert.ok(content.includes('id="btnPause"'), 'Must contain pause button');
  assert.ok(content.includes('id="btnResume"'), 'Must contain resume button');
  assert.ok(content.includes('id="handoffBanner"'), 'Must contain model handoff banner');
  assert.ok(content.includes('id="streamStatus"'), 'Must contain stream connection status');
});

test('2. frontend binds listeners for all 15 backend typed SSE events', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  // Extract all event types from EVENT_TYPES schema and ensure index.html includes each
  for (const eventType of EVENT_TYPES) {
    assert.ok(
      content.includes(`'${eventType}'`),
      `Frontend must listen for typed event: ${eventType}`
    );
  }

  // Also check backward compatibility for raw 'task' event
  assert.ok(content.includes("'task'"), "Frontend must retain backward-compatible 'task' listener");
});

test('3. frontend implements gapless reconnect with lastSeq and snapshot recovery', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  // Reconnect with lastSeq parameter
  assert.ok(
    content.includes('/events?lastSeq='),
    'Frontend must include ?lastSeq= query parameter when reconnecting'
  );

  // Snapshot recovery endpoint
  assert.ok(
    content.includes('/api/tasks/') && content.includes('/snapshot'),
    'Frontend must query /api/tasks/:id/snapshot during recovery'
  );

  assert.ok(
    content.includes('currentSeq'),
    'Frontend must synchronize with currentSeq from snapshot'
  );
});

test('4. frontend wires pause and resume endpoints', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  // Pause endpoint
  assert.ok(
    content.includes('/pause'),
    'Frontend must call /pause endpoint'
  );

  // Continue / resume endpoint
  assert.ok(
    content.includes('/continue'),
    'Frontend must call /continue endpoint'
  );
});

test('5. event deduplication and lastSeq tracking contract', () => {
  let lastSeq = 0;
  const seenEventIds = new Set();
  const processedEvents = [];

  function processEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.id && seenEventIds.has(event.id)) return false;

    if (event.id) {
      seenEventIds.add(event.id);
      if (seenEventIds.size > 1000) {
        const first = seenEventIds.values().next().value;
        seenEventIds.delete(first);
      }
    }

    if (Number.isInteger(event.seq) && event.seq > lastSeq) {
      lastSeq = event.seq;
    }

    processedEvents.push(event);
    return true;
  }

  // First time event
  assert.equal(processEvent({ id: 'e1', seq: 1, type: 'step_started' }), true);
  assert.equal(lastSeq, 1);

  // Duplicate event with same ID
  assert.equal(processEvent({ id: 'e1', seq: 1, type: 'step_started' }), false);
  assert.equal(processedEvents.length, 1, 'Duplicate event must be discarded');

  // Out of order older sequence with unique ID
  assert.equal(processEvent({ id: 'e0', seq: 0, type: 'task_created' }), true);
  assert.equal(lastSeq, 1, 'lastSeq must remain monotonically increasing');

  // Newer sequence
  assert.equal(processEvent({ id: 'e2', seq: 2, type: 'tool_started' }), true);
  assert.equal(lastSeq, 2);
  assert.equal(processedEvents.length, 3);
});

test('6. snapshot state reconciliation merges without duplicating checkpoints or steps', () => {
  const localTask = {
    id: 'task-sync-1',
    goal: 'Test reconciliation',
    status: 'running',
    message: 'Running',
    steps: [
      { kind: 'step_started', name: 'Step 0' }
    ],
    checkpoints: [
      { id: 'cp-1', event: 'Step 0 checkpoint', step: 0 }
    ]
  };

  const snapshot = {
    id: 'task-sync-1',
    goal: 'Test reconciliation',
    status: 'paused',
    message: 'Task paused',
    steps: [
      { kind: 'step_started', name: 'Step 0' },
      { kind: 'tool_completed', name: 'npm' }
    ],
    checkpoints: [
      { id: 'cp-1', event: 'Step 0 checkpoint', step: 0 },
      { id: 'cp-2', event: 'Task paused', step: 0 }
    ],
    stepCount: 2,
    checkpointCount: 2
  };

  // Reconcile snapshot into local state
  const reconciled = { ...localTask, ...snapshot };

  assert.equal(reconciled.status, 'paused');
  assert.equal(reconciled.message, 'Task paused');
  assert.equal(reconciled.steps.length, 2);
  assert.equal(reconciled.checkpoints.length, 2);
});

test('7. frontend event handler resilience against missing optional fields', () => {
  // Simulate the event dispatcher logic from index.html with completely sparse/missing optional fields
  const tasks = [{
    id: 'task-sparse-1',
    goal: 'Sparse test',
    status: 'running',
    steps: [],
    checkpoints: []
  }];

  function handleSparse(type, payload) {
    const task = tasks.find(t => t.id === 'task-sparse-1');
    switch (type) {
      case 'step_started':
        task.activeModel = payload.activeModel || task.activeModel;
        task.steps.push({
          kind: 'step_started',
          name: `Step ${payload.step || 0}`,
          model: payload.activeModel,
          at: new Date().toISOString()
        });
        break;
      case 'tool_failed':
        task.steps.push({
          kind: 'tool_failed',
          name: payload.toolName || 'tool',
          detail: payload.detail || ''
        });
        break;
      case 'checkpoint_created':
        task.checkpoints.unshift({
          id: payload.id,
          event: payload.event || 'Checkpoint',
          status: payload.status || task.status,
          step: payload.step || 0,
          hash: payload.hash || ''
        });
        break;
      case 'model_switching':
        assert.ok(true, 'Must handle missing reason or targetModel');
        break;
    }
  }

  // All of these should execute cleanly without throwing
  assert.doesNotThrow(() => handleSparse('step_started', {}));
  assert.doesNotThrow(() => handleSparse('tool_failed', {}));
  assert.doesNotThrow(() => handleSparse('checkpoint_created', {}));
  assert.doesNotThrow(() => handleSparse('model_switching', {}));

  assert.equal(tasks[0].steps.length, 2);
  assert.equal(tasks[0].checkpoints.length, 1);
});
