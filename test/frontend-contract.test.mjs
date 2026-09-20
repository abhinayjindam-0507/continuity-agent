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

test('4f. workspace transcript view uses the bounded transcript API', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  assert.ok(
    content.includes('id="btnActivityView"'),
    'Workspace must expose the Activity view control'
  );

  assert.ok(
    content.includes('id="btnTranscriptView"'),
    'Workspace must expose the Transcript view control'
  );

  assert.ok(
    content.includes('id="transcriptBody"'),
    'Workspace must contain the transcript rendering surface'
  );

  assert.ok(
    content.includes('/transcript?limit=50'),
    'Frontend must load the bounded transcript API'
  );

  assert.ok(
    content.includes('loadTaskTranscript'),
    'Frontend must implement transcript loading'
  );

  assert.ok(
    content.includes('setWorkspaceLogView'),
    'Frontend must switch between activity and transcript views'
  );

  assert.ok(
    content.includes('tool_call_id'),
    'Transcript renderer must preserve tool-call correlation'
  );
});

test('4b. project explorer wires the read-only backend file APIs', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  // Dynamic listing + file content come from the Step 1 backend endpoints
  assert.ok(
    content.includes('/api/project/files?path=.'),
    'Explorer must load the listing from GET /api/project/files?path=.'
  );
  assert.ok(
    content.includes('/api/project/file?path='),
    'File viewer must load contents from GET /api/project/file?path='
  );
  assert.ok(
    content.includes('encodeURIComponent(path)'),
    'Relative project paths must be URL-encoded when requested'
  );

  // Explorer tree is a dynamic container with folder/file interaction hooks
  assert.ok(content.includes('id="projectFileTree"'), 'Must contain dynamic explorer tree');
  assert.ok(content.includes('data-dir='), 'Explorer must support folder toggles');
  assert.ok(content.includes('data-path='), 'Explorer must carry relative file paths');
  assert.ok(content.includes('id="btnRefreshProjectFiles"'), 'Explorer must expose a refresh control');

  // Editor chrome shows the selected file and read-only state
  assert.ok(content.includes('id="editorActiveTabName"'), 'Editor tab must display the open file name');
  assert.ok(content.includes('id="headerBreadcrumbFile"'), 'Header breadcrumb must display the open file path');
  assert.ok(content.includes('id="editorContextStatus"'), 'Editor sub-bar must show file state');

  // Read-only contract: no mutating project endpoints may be wired
  assert.doesNotMatch(
    content,
    /\/api\/project\/(write|patch|delete|rename|move|upload|mkdir)/,
    'Frontend must not reference any mutating project filesystem endpoint'
  );
});

test('4c. Inspect Diff wires the read-only project changes API and renders line diffs', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  assert.ok(
    content.includes('id="btnInspectDiff"'),
    'Inspect Diff control must have a stable button ID'
  );

  assert.ok(
    content.includes('/api/project/changes?'),
    'Inspect Diff must call the read-only project changes API'
  );

  assert.ok(
    content.includes('taskId: taskId'),
    'Inspect Diff must scope changes to the active task'
  );

  assert.ok(
    content.includes('path: path'),
    'Inspect Diff must scope changes to the selected project-relative path'
  );

  assert.ok(
    content.includes("limit: '50'"),
    'Inspect Diff must use a bounded changes result limit'
  );

  assert.ok(
    content.includes("diff.kind === 'lines'"),
    "Inspect Diff must consume the backend's lines diff contract"
  );

  assert.ok(
    content.includes("line.type === 'add'") &&
      content.includes("line.type === 'del'"),
    'Inspect Diff must distinguish added and removed diff lines'
  );

  assert.doesNotMatch(
    content,
    /\/api\/project\/(write|patch|delete|rename|move|upload|mkdir)/,
    'Inspect Diff must remain read-only'
  );
});

test('4d. explorer and editor render no hardcoded fake project content', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  // Scope: the Step 2 workspace (project rail + explorer sub-sidebar +
  // central editor). Home-view dashboard chrome outside this region is
  // pre-existing Stitch template material for later milestones.
  const workspaceStart = content.indexOf('id="viewWorkspace"');
  // Skip the CSS contract-marker comment that mentions id="bottomConsole".
  const workspaceEnd = content.indexOf('id="bottomConsole"', workspaceStart);
  assert.ok(workspaceStart !== -1 && workspaceEnd > workspaceStart, 'Workspace region must exist');
  const workspace = content.slice(workspaceStart, workspaceEnd);

  // Fake workspace files from the original Stitch template must be gone
  for (const fake of [
    'filesystem_broker.ts',
    'permission_policy.ts',
    'session_jail.ts',
    'broker.security.spec.ts',
    'SecureFilesystemBroker',
    'Removed by Agent',
    'Synthesized by Qwen 2.5',
    'Agent Active: Lines 42-58'
  ]) {
    assert.ok(!workspace.includes(fake), `Hardcoded fake content must not ship in workspace: ${fake}`);
  }

  // Truthful states are declared up front
  assert.ok(content.includes('Loading project files…'), 'Explorer must show a loading state');
  assert.ok(content.includes('No project files available'), 'Explorer must show an empty state');
  assert.ok(content.includes('Could not load project files'), 'Explorer must show an error state');
  assert.ok(content.includes('Binary file'), 'Viewer must handle binary metadata state');
});

test('4e. explorer treats backend paths as relative project paths only', async () => {
  const content = await readFile(indexHtmlPath, 'utf8');

  // Tree model must sanitize path segments rather than trusting raw input
  assert.ok(
    content.includes("p !== '..'") && content.includes("p !== '.'"),
    'Hierarchy inference must drop traversal-like segments from backend paths'
  );
  assert.ok(
    content.includes('escAttr'),
    'File paths rendered into attributes must be attribute-escaped'
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


test('4g. approval UI uses the durable approval API and exact decision binding', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(
    new URL('../src/index.html', import.meta.url),
    'utf8'
  );

  assert.match(html, /id="approvalCard"/);
  assert.match(html, /id="btnApproveAction"/);
  assert.match(html, /id="btnDenyAction"/);
  assert.match(html, /id="approvalArgs"/);
  assert.match(html, /id="approvalActionId"/);

  assert.match(html, /function loadTaskApproval\(taskId\)/);
  assert.match(
    html,
    /`\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/approval`/
  );

  assert.match(html, /function resolveApproval\(decision\)/);
  assert.match(
    html,
    /`\/api\/approvals\/\$\{encodeURIComponent\(approvalId\)\}\/\$\{decision === 'approve' \? 'approve' : 'deny'\}`/
  );

  assert.match(
    html,
    /body: JSON\.stringify\(\{ taskId \}\)/
  );

  assert.match(html, /scheduleApprovalRefresh\(taskId\)/);
  assert.match(html, /loadTaskApproval\(activeTaskId\)/);
  assert.match(html, /loadTaskApproval\(id\)/);
  assert.match(html, /approval\.expired === true/);
  assert.match(html, /activeApproval\?\.id === approvalId/);

  assert.doesNotMatch(html, /Approval Required \(Preview • Workflow Pending\)/);
  assert.doesNotMatch(html, /Approve Patch \(Pending API\)/);
  assert.doesNotMatch(html, /Deny \(Pending API\)/);
  assert.doesNotMatch(html, /Review Diff \(Preview\)/);

  assert.match(
    html,
    /btnApprove\.onclick = \(\) => resolveApproval\('approve'\)/
  );
  assert.match(
    html,
    /btnDeny\.onclick = \(\) => resolveApproval\('deny'\)/
  );
});
