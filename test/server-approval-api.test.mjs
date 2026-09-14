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
  computeToolIdempotencyKey
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

test('continue route does not bypass awaiting approval', async () => {
  const task = seedStore.getTasks().find(item => item.id === TASK_ID);
  assert.equal(task?.status, 'awaiting_approval');

  const result = await request(
    'POST',
    `/api/tasks/${TASK_ID}/continue`
  );

  assert.equal(result.status, 409);

  const after = seedStore.getTasks().find(item => item.id === TASK_ID);
  assert.equal(after?.status, 'awaiting_approval');
});
