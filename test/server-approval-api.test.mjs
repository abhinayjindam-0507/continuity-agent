import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { before, after, test } from 'node:test';

import {
  openStore,
  computeToolIdempotencyKey,
  computeCheckpointHash
} from '../src/store.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const TASK_ID = 'task-approval-api';
const ACTION_ID = 'action-approval-api';
const APPROVAL_ID = 'approval-approval-api';

let dataRoot;
let projectDir;
let seedStore;
let serverProcess;
let port;

async function seedTask(taskId = TASK_ID) {
  await seedStore.upsertTask({
    id: taskId,
    goal: 'Approval API verification task',
    status: 'awaiting_approval',
    message: 'Approval required for write_file.',
    activeModel: 'qwen3:4b',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    steps: [],
    checkpoints: [],
    switches: []
  });
}

async function seedApproval({
  id = APPROVAL_ID,
  taskId = TASK_ID,
  toolActionId = ACTION_ID,
  toolName = 'write_file',
  args = {
    path: 'approved.txt',
    content: 'approved content\n'
  },
  expiresAt = '2099-01-01T00:00:00.000Z'
} = {}) {
  const action = seedStore.recordToolAction({
    id: toolActionId,
    taskId,
    toolName,
    toolCallId: `${id}-tool-call`,
    args,
    status: 'pending',
    policyDecision: 'requires_approval',
    startedAt: '2026-01-01T00:01:00.000Z'
  });

  seedStore.createApprovalRequest({
    id,
    taskId,
    toolActionId: action.id,
    toolName,
    args,
    createdAt: '2026-01-01T00:01:01.000Z',
    expiresAt
  });

  return seedStore.getApprovalRequest(id);
}

function startServer() {
  return new Promise((resolvePromise, rejectPromise) => {
    port = 30_000 + Math.floor(Math.random() * 20_000);

    serverProcess = spawn(
      process.execPath,
      [join(repoRoot, 'src', 'server.mjs')],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PROJECT_ROOT: projectDir,
          DATA_ROOT: dataRoot,
          PORT: String(port)
        }
      }
    );

    let stdout = '';
    let stderr = '';

    serverProcess.stdout.on('data', chunk => {
      stdout += chunk;
    });

    serverProcess.stderr.on('data', chunk => {
      stderr += chunk;
    });

    serverProcess.on('exit', code => {
      rejectPromise(
        new Error(
          `Server exited early (${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    });

    const poll = async attemptsLeft => {
      if (attemptsLeft <= 0) {
        rejectPromise(
          new Error(
            `Server never became ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
        return;
      }

      try {
        const probe = await fetch(
          `http://127.0.0.1:${port}/api/models`
        );

        if (probe.ok) {
          resolvePromise();
          return;
        }
      } catch {
        // Keep polling while the process starts.
      }

      setTimeout(() => poll(attemptsLeft - 1), 100);
    };

    poll(150);
  });
}

async function request(method, target, body) {
  const response = await fetch(
    `http://127.0.0.1:${port}${target}`,
    {
      method,
      headers: body
        ? { 'content-type': 'application/json' }
        : undefined,
      body: body ? JSON.stringify(body) : undefined
    }
  );

  const text = await response.text();

  let parsed = null;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON response.
  }

  return {
    status: response.status,
    text,
    body: parsed
  };
}

before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'approval-api-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'approval-api-project-'));

  await writeFile(
    join(projectDir, 'existing.txt'),
    'existing\n'
  );

  await startServer();

  seedStore = await openStore(dataRoot);

  await seedTask();
  await seedApproval();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => {});
  }

  try {
    seedStore?.close();
  } catch {
    // already closed
  }

  await rm(dataRoot, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test('GET returns the current pending approval with bounded sanitized arguments', async () => {
  const taskId = 'task-approval-read-api';
  const approvalId = 'approval-read-api';

  await seedTask(taskId);
  await seedApproval({
    id: approvalId,
    taskId,
    toolActionId: 'action-approval-read-api',
    args: {
      path: 'review.txt',
      content: 'visible proposed content\n',
      token: 'do-not-leak',
      nested: {
        apiKey: 'nested-secret'
      }
    }
  });

  const result = await request(
    'GET',
    `/api/tasks/${taskId}/approval`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.source, 'sqlite');
  assert.equal(result.body?.taskId, taskId);
  assert.equal(result.body?.approval?.id, approvalId);
  assert.equal(result.body?.approval?.status, 'pending');
  assert.equal(result.body?.approval?.toolName, 'write_file');
  assert.equal(result.body?.approval?.args?.path, 'review.txt');
  assert.equal(
    result.body?.approval?.args?.content,
    'visible proposed content\n'
  );
  assert.equal(result.body?.approval?.args?.token, undefined);
  assert.equal(result.body?.approval?.args?.nested?.apiKey, undefined);
  assert.ok(!result.text.includes('do-not-leak'));
  assert.ok(!result.text.includes('nested-secret'));
});

test('GET approval rejects an unknown task', async () => {
  const result = await request(
    'GET',
    '/api/tasks/task-does-not-exist/approval'
  );

  assert.equal(result.status, 404);
  assert.equal(result.body?.error, 'Task not found.');
});

test('GET approval exposes expired state without making it resolvable', async () => {
  const taskId = 'task-approval-expired-read-api';

  await seedStore.upsertTask({
    id: taskId,
    goal: 'Expired approval task',
    status: 'awaiting_approval',
    message: 'Approval required for write_file.',
    activeModel: 'qwen3:4b',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    steps: [],
    checkpoints: [],
    switches: []
  });

  await seedApproval({
    id: 'approval-expired-read-api',
    taskId,
    toolActionId: 'action-expired-read-api',
    expiresAt: '2020-01-01T00:00:00.000Z'
  });

  const result = await request(
    'GET',
    `/api/tasks/${taskId}/approval`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.approval?.status, 'pending');
  assert.equal(result.body?.approval?.expired, true);
  assert.equal(result.body?.approval?.canResolve, false);
});

test('GET approval reports when a task has no pending approval', async () => {
  const taskId = 'task-approval-no-pending-api';

  await seedStore.upsertTask({
    id: taskId,
    goal: 'No pending approval task',
    status: 'paused',
    message: 'Paused without approval.',
    activeModel: 'qwen3:4b',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    steps: [],
    checkpoints: [],
    switches: []
  });

  const result = await request(
    'GET',
    `/api/tasks/${taskId}/approval`
  );

  assert.equal(result.status, 404);
  assert.equal(
    result.body?.error,
    'No pending approval request for this task.'
  );
});

test('approval route rejects unknown approval request', async () => {
  const result = await request(
    'POST',
    '/api/approvals/does-not-exist/approve'
  );

  assert.equal(result.status, 404);
  assert.equal(result.body?.error, 'Approval request not found.');
});

test('approval route requires the exact bound task when supplied', async () => {
  const result = await request(
    'POST',
    `/api/approvals/${APPROVAL_ID}/approve`,
    { taskId: 'wrong-task' }
  );

  assert.equal(result.status, 409);
  assert.equal(
    result.body?.error,
    'Approval request task binding mismatch.'
  );

  const approval = seedStore.getApprovalRequest(APPROVAL_ID);
  assert.equal(approval.status, 'pending');

  const action = seedStore.getToolAction(ACTION_ID);
  assert.equal(action.status, 'pending');
});

test('approve route resolves approval before exact mutation execution', async () => {
  const result = await request(
    'POST',
    `/api/approvals/${APPROVAL_ID}/approve`,
    { taskId: TASK_ID }
  );

  assert.notEqual(result.status, 404);
  assert.notEqual(result.status, 409);

  const approval = seedStore.getApprovalRequest(APPROVAL_ID);
  const action = seedStore.getToolAction(ACTION_ID);

  assert.equal(approval.status, 'consumed');
  assert.equal(action.status, 'success');

  const approvedTask = seedStore
    .getTasks()
    .find(item => item.id === TASK_ID);

  assert.ok(
    approvedTask?.status === 'running' ||
      approvedTask?.status === 'completed',
    `expected approved task to resume, got ${approvedTask?.status}`
  );

  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.approval?.id, APPROVAL_ID);
  assert.equal(result.body?.action?.id, ACTION_ID);
});

test('approve route is idempotent after successful execution', async () => {
  const result = await request(
    'POST',
    `/api/approvals/${APPROVAL_ID}/approve`,
    { taskId: TASK_ID }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.replayed, true);

  const approval = seedStore.getApprovalRequest(APPROVAL_ID);
  const action = seedStore.getToolAction(ACTION_ID);

  assert.equal(approval.status, 'consumed');
  assert.equal(action.status, 'success');
});

test('deny route resolves approval without executing the action', async () => {
  const deniedTaskId = 'task-approval-deny-api';
  const deniedApprovalId = 'approval-denied-api';
  const deniedActionId = 'action-denied-api';

  await seedTask(deniedTaskId);

  await seedApproval({
    id: deniedApprovalId,
    taskId: deniedTaskId,
    toolActionId: deniedActionId,
    args: {
      path: 'denied.txt',
      content: 'should not execute\n'
    }
  });

  const result = await request(
    'POST',
    `/api/approvals/${deniedApprovalId}/deny`,
    { taskId: deniedTaskId }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.ok, true);
  assert.equal(result.body?.approval?.status, 'denied');

  const approval = seedStore.getApprovalRequest(deniedApprovalId);
  const action = seedStore.getToolAction(deniedActionId);

  assert.equal(approval.status, 'denied');
  assert.equal(action.status, 'pending');
});

test('continue route fails closed before creating a new checkpoint when the latest checkpoint is corrupted', async () => {
  const taskId = 'task-corrupted-continue-api';
  const checkpointId = 'cp-corrupted-continue-api';

  await seedStore.upsertTask({
    id: taskId,
    goal: 'Corrupted continue verification task',
    status: 'paused',
    message: 'Task paused before resume.',
    activeModel: 'qwen3:4b',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    steps: [],
    checkpoints: [],
    switches: []
  });

  const checkpointData = {
    id: checkpointId,
    taskId,
    createdAt: '2026-01-01T00:00:01.000Z',
    event: 'Task paused',
    status: 'paused',
    activeModel: 'qwen3:4b',
    step: 0,
    workspace: projectDir
  };

  seedStore.recordCheckpoint({
    ...checkpointData,
    integrityHash: computeCheckpointHash(checkpointData)
  });

  seedStore.database
    .prepare('UPDATE checkpoints SET step = ? WHERE id = ?')
    .run(999, checkpointId);

  const result = await request(
    'POST',
    `/api/tasks/${taskId}/continue`
  );

  assert.equal(result.status, 409);
  assert.equal(result.body?.recoveryRequired, true);
  assert.match(
    result.body?.error || '',
    /Corrupted checkpoint integrity/
  );

  const after = seedStore
    .getTasks()
    .find(item => item.id === taskId);

  assert.equal(after?.status, 'paused');

  const checkpoints = seedStore.getCheckpoints(taskId);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].id, checkpointId);

  const raw = seedStore.database
    .prepare(
      'SELECT step, integrity_hash FROM checkpoints WHERE id = ?'
    )
    .get(checkpointId);

  assert.ok(raw);
  assert.equal(raw.step, 999);
  assert.equal(
    raw.integrity_hash,
    computeCheckpointHash(checkpointData)
  );
});

test('transcript route returns bounded sanitized durable messages', async () => {
  const taskId = 'task-transcript-api';
  const now = '2026-01-01T01:00:00.000Z';

  await seedStore.upsertTask({
    id: taskId,
    goal: 'Transcript API verification task',
    status: 'paused',
    message: 'Paused',
    activeModel: 'qwen3:4b',
    createdAt: now,
    updatedAt: now,
    steps: [],
    checkpoints: [],
    switches: []
  });

  seedStore.appendTaskMessage({
    id: 'transcript-api-1',
    taskId,
    createdAt: now,
    message: {
      role: 'user',
      content: 'First user message'
    }
  });

  seedStore.appendTaskMessage({
    id: 'transcript-api-2',
    taskId,
    createdAt: now,
    message: {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({
              path: 'src/index.html',
              apiKey: 'must-not-leak'
            })
          }
        }
      ]
    }
  });

  seedStore.appendTaskMessage({
    id: 'transcript-api-3',
    taskId,
    createdAt: now,
    message: {
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'tool-result'
    }
  });

  const result = await request(
    'GET',
    `/api/tasks/${taskId}/transcript?limit=2`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.taskId, taskId);
  assert.equal(result.body?.source, 'sqlite');
  assert.equal(result.body?.totalCount, 3);
  assert.equal(result.body?.returnedCount, 2);
  assert.equal(result.body?.truncated, true);
  assert.equal(result.body?.messages?.length, 2);

  assert.equal(
    result.body.messages[0].message.role,
    'assistant'
  );
  assert.equal(
    result.body.messages[0].message.tool_calls[0].id,
    'call-1'
  );
  assert.equal(
    result.body.messages[0].message.tool_calls[0].function.name,
    'read_file'
  );
  assert.doesNotMatch(
    result.body.messages[0].message.tool_calls[0].function.arguments,
    /apiKey|must-not-leak/
  );

  assert.equal(
    result.body.messages[1].message.role,
    'tool'
  );
  assert.equal(
    result.body.messages[1].message.tool_call_id,
    'call-1'
  );
});

test('transcript route redacts malformed tool arguments', async () => {
  const malformedTaskId = 'task-transcript-api-malformed';
  const now = '2026-01-01T01:00:00.000Z';

  await seedStore.upsertTask({
    id: malformedTaskId,
    goal: 'Malformed transcript verification task',
    status: 'paused',
    message: 'Paused',
    activeModel: 'qwen3:4b',
    createdAt: now,
    updatedAt: now,
    steps: [],
    checkpoints: [],
    switches: []
  });

  seedStore.appendTaskMessage({
    id: 'transcript-api-malformed-1',
    taskId: malformedTaskId,
    createdAt: now,
    message: {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call-malformed',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: 'apiKey=must-not-leak'
          }
        }
      ]
    }
  });

  const malformedResult = await request(
    'GET',
    `/api/tasks/${malformedTaskId}/transcript`
  );

  assert.equal(malformedResult.status, 200);
  assert.equal(
    malformedResult.body?.messages?.[0]?.message?.tool_calls?.[0]?.function?.arguments,
    '[continuity-agent: tool arguments redacted]'
  );
  assert.doesNotMatch(
    malformedResult.body?.messages?.[0]?.message?.tool_calls?.[0]?.function?.arguments || '',
    /must-not-leak/
  );
});

test('continue route does not bypass awaiting approval', async () => {
  const continueTaskId = 'task-approval-continue-api';

  await seedTask(continueTaskId);

  const task = seedStore
    .getTasks()
    .find(item => item.id === continueTaskId);

  assert.equal(task?.status, 'awaiting_approval');

  const result = await request(
    'POST',
    `/api/tasks/${continueTaskId}/continue`
  );

  assert.equal(result.status, 409);

  const after = seedStore
    .getTasks()
    .find(item => item.id === continueTaskId);

  assert.equal(after?.status, 'awaiting_approval');
});
