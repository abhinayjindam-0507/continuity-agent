import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openStore } from '../src/store.mjs';
import { createOrchestrator } from '../src/orchestrator/orchestrator.mjs';

test('approved action claim is atomic and remains bound to the persisted action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-execution-test-'));

  try {
    const store = await openStore(dir);

    const taskId = 'task-claim';
    const toolActionId = 'action-claim';

    const args = {
      path: 'src/example.txt',
      content: 'approved content'
    };

    store.createApprovalRequest({
      id: 'approval-claim',
      taskId,
      toolActionId,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    });

    store.recordToolAction({
      id: toolActionId,
      taskId,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'pending'
    });

    const approved = store.resolveApprovalRequest('approval-claim', {
      status: 'approved',
      resolutionReason: 'Approved for exact persisted action.'
    });

    assert.equal(approved.status, 'approved');

    const claimed = store.claimToolActionForApproval({
      taskId,
      toolActionId,
      toolName: 'write_file',
      args
    });

    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.id, toolActionId);

    assert.throws(
      () =>
        store.claimToolActionForApproval({
          taskId,
          toolActionId,
          toolName: 'write_file',
          args: {
            ...args,
            content: 'DIFFERENT CONTENT'
          }
        }),
      /binding|argument|mismatch|status/i
    );

    const persisted = store.getToolAction(toolActionId);
    assert.equal(persisted.status, 'in_progress');

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an approved action cannot be claimed twice with the same exact arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-execution-replay-test-'));

  try {
    const store = await openStore(dir);

    const taskId = 'task-replay';
    const toolActionId = 'action-replay';

    const args = {
      path: 'src/replay.txt',
      content: 'exact approved content'
    };

    store.createApprovalRequest({
      id: 'approval-replay',
      taskId,
      toolActionId,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    });

    store.recordToolAction({
      id: toolActionId,
      taskId,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'pending'
    });

    store.resolveApprovalRequest('approval-replay', {
      status: 'approved',
      resolutionReason: 'Approved for exact persisted action.'
    });

    const firstClaim = store.claimToolActionForApproval({
      taskId,
      toolActionId,
      toolName: 'write_file',
      args
    });

    assert.equal(firstClaim.status, 'in_progress');

    assert.throws(
      () =>
        store.claimToolActionForApproval({
          taskId,
          toolActionId,
          toolName: 'write_file',
          args
        }),
      /not claimable|status|in_progress/i
    );

    const persisted = store.getToolAction(toolActionId);
    assert.equal(persisted.status, 'in_progress');

    const approval = store.getApprovalRequest('approval-replay');
    assert.equal(approval.status, 'approved');

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('approved persisted mutation exposes an exact-action orchestrator executor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-orchestrator-test-'));
  let store = null;

  try {
    store = await openStore(dir);

    const task = {
      id: 'task-approved-execution',
      goal: 'Execute approved mutation',
      status: 'awaiting_approval',
      message: 'Waiting for approval',
      activeModel: 'qwen3:4b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    };

    store.upsertTask(task);

    const args = {
      path: 'approved.txt',
      content: 'approved exact content'
    };

    const action = store.recordToolAction({
      id: 'action-approved-execution',
      taskId: task.id,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'pending'
    });

    store.createApprovalRequest({
      id: 'approval-approved-execution',
      taskId: task.id,
      toolActionId: action.id,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    });

    store.resolveApprovalRequest('approval-approved-execution', {
      status: 'approved',
      resolutionReason: 'Approved for exact persisted action.'
    });

    const brokerCalls = [];

    const orchestrator = createOrchestrator({
      getTasks: async () => [store.getTask(task.id)],
      saveTasks: async tasks => {
        for (const item of tasks) {
          store.upsertTask(item);
        }
      },
      getConfig: async () => ({
        allowWrites: false,
        allowedCommands: []
      }),
      toolBrokerFactory: async () => ({
        filesystemBroker: {
          readFile: async () => ({
            path: 'approved.txt',
            content: 'before content',
            size: 14
          })
        },
        execute: async call => {
          brokerCalls.push(call);
          return {
            path: call.arguments.path,
            changed: true,
            newBytes: Buffer.byteLength(call.arguments.content, 'utf8')
          };
        }
      }),
      modelAdapter: async () => {
        throw new Error('Model must not be invoked during approved execution');
      },
      modelRouter: {},
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    assert.equal(typeof orchestrator.executeApprovedAction, 'function');

    await orchestrator.executeApprovedAction({
      taskId: task.id,
      approvalId: 'approval-approved-execution'
    });

    assert.equal(brokerCalls.length, 1);
    assert.deepEqual(brokerCalls[0], {
      name: 'write_file',
      arguments: args
    });
  } finally {
    store?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('denied approval never reaches the broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-denied-test-'));
  let store = null;

  try {
    store = await openStore(dir);

    const taskId = 'task-denied';
    const actionId = 'action-denied';

    const args = {
      path: 'denied.txt',
      content: 'must not execute'
    };

    store.recordToolAction({
      id: actionId,
      taskId,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'pending'
    });

    store.createApprovalRequest({
      id: 'approval-denied',
      taskId,
      toolActionId: actionId,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    });

    store.resolveApprovalRequest('approval-denied', {
      status: 'denied',
      resolutionReason: 'User denied the mutation.'
    });

    let brokerCalls = 0;

    const orchestrator = createOrchestrator({
      getTasks: async () => [store.getTask(taskId)].filter(Boolean),
      saveTasks: async () => {},
      getConfig: async () => ({ allowWrites: false, allowedCommands: [] }),
      toolBrokerFactory: async () => ({
        execute: async () => {
          brokerCalls += 1;
          throw new Error('BROKER MUST NOT EXECUTE');
        }
      }),
      modelAdapter: async () => {
        throw new Error('Model must not be invoked');
      },
      modelRouter: {},
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    await assert.rejects(
      () =>
        orchestrator.executeApprovedAction({
          taskId,
          approvalId: 'approval-denied'
        }),
      /not executable|denied/i
    );

    assert.equal(brokerCalls, 0);
    assert.equal(store.getToolAction(actionId).status, 'pending');
  } finally {
    store?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired approval never reaches the broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-expired-test-'));
  let store = null;

  try {
    store = await openStore(dir);

    const taskId = 'task-expired';
    const actionId = 'action-expired';

    const args = {
      path: 'expired.txt',
      content: 'must not execute'
    };

    store.recordToolAction({
      id: actionId,
      taskId,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'pending'
    });

    store.createApprovalRequest({
      id: 'approval-expired',
      taskId,
      toolActionId: actionId,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });

    // Resolve while the request is already expired; the store transitions it
    // to expired rather than approved.
    const expired = store.resolveApprovalRequest('approval-expired', {
      status: 'approved',
      resolutionReason: 'Too late to approve.'
    });

    assert.equal(expired.status, 'expired');

    let brokerCalls = 0;

    const orchestrator = createOrchestrator({
      getTasks: async () => [],
      saveTasks: async () => {},
      getConfig: async () => ({ allowWrites: false, allowedCommands: [] }),
      toolBrokerFactory: async () => ({
        execute: async () => {
          brokerCalls += 1;
          throw new Error('BROKER MUST NOT EXECUTE');
        }
      }),
      modelAdapter: async () => {
        throw new Error('Model must not be invoked');
      },
      modelRouter: {},
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    await assert.rejects(
      () =>
        orchestrator.executeApprovedAction({
          taskId,
          approvalId: 'approval-expired'
        }),
      /not executable|expired/i
    );

    assert.equal(brokerCalls, 0);
    assert.equal(store.getToolAction(actionId).status, 'pending');
  } finally {
    store?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('consumed approval never reaches the broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-consumed-test-'));
  let store = null;

  try {
    store = await openStore(dir);

    const taskId = 'task-consumed';
    const actionId = 'action-consumed';

    const args = {
      path: 'consumed.txt',
      content: 'must not execute'
    };

    store.recordToolAction({
      id: actionId,
      taskId,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'pending'
    });

    store.createApprovalRequest({
      id: 'approval-consumed',
      taskId,
      toolActionId: actionId,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    });

    store.resolveApprovalRequest('approval-consumed', {
      status: 'approved',
      resolutionReason: 'Approved once.'
    });

    store.consumeApprovalRequest('approval-consumed', {
      taskId,
      toolActionId: actionId,
      toolName: 'write_file',
      args
    });

    assert.equal(
      store.getApprovalRequest('approval-consumed').status,
      'consumed'
    );

    let brokerCalls = 0;

    const orchestrator = createOrchestrator({
      getTasks: async () => [],
      saveTasks: async () => {},
      getConfig: async () => ({ allowWrites: false, allowedCommands: [] }),
      toolBrokerFactory: async () => ({
        execute: async () => {
          brokerCalls += 1;
          throw new Error('BROKER MUST NOT EXECUTE');
        }
      }),
      modelAdapter: async () => {
        throw new Error('Model must not be invoked');
      },
      modelRouter: {},
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    await assert.rejects(
      () =>
        orchestrator.executeApprovedAction({
          taskId,
          approvalId: 'approval-consumed'
        }),
      /not executable|consumed/i
    );

    assert.equal(brokerCalls, 0);
    assert.equal(store.getToolAction(actionId).status, 'pending');
  } finally {
    store?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('needs_verification action never reaches the broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-verification-test-'));
  let store = null;

  try {
    store = await openStore(dir);

    const taskId = 'task-verification';
    const actionId = 'action-verification';

    const args = {
      path: 'verification.txt',
      content: 'must not execute'
    };

    store.recordToolAction({
      id: actionId,
      taskId,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'needs_verification'
    });

    store.createApprovalRequest({
      id: 'approval-verification',
      taskId,
      toolActionId: actionId,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    });

    store.resolveApprovalRequest('approval-verification', {
      status: 'approved',
      resolutionReason: 'Approval exists but action needs verification.'
    });

    let brokerCalls = 0;

    const orchestrator = createOrchestrator({
      getTasks: async () => [],
      saveTasks: async () => {},
      getConfig: async () => ({ allowWrites: false, allowedCommands: [] }),
      toolBrokerFactory: async () => ({
        execute: async () => {
          brokerCalls += 1;
          throw new Error('BROKER MUST NOT EXECUTE');
        }
      }),
      modelAdapter: async () => {
        throw new Error('Model must not be invoked');
      },
      modelRouter: {},
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    await assert.rejects(
      () =>
        orchestrator.executeApprovedAction({
          taskId,
          approvalId: 'approval-verification'
        }),
      /not claimable|needs_verification|status/i
    );

    assert.equal(brokerCalls, 0);
    assert.equal(
      store.getToolAction(actionId).status,
      'needs_verification'
    );
  } finally {
    store?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable success survives approval-consumption failure and retry never re-executes the broker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'approval-recovery-test-'));
  let store = null;

  try {
    store = await openStore(dir);

    const taskId = 'task-recovery';
    const actionId = 'action-recovery';
    const approvalId = 'approval-recovery';

    const args = {
      path: 'recovery.txt',
      content: 'durable approved content'
    };

    store.recordToolAction({
      id: actionId,
      taskId,
      toolName: 'write_file',
      args,
      policyDecision: 'requires_approval',
      status: 'pending'
    });

    store.createApprovalRequest({
      id: approvalId,
      taskId,
      toolActionId: actionId,
      toolName: 'write_file',
      args,
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    });

    store.resolveApprovalRequest(approvalId, {
      status: 'approved',
      resolutionReason: 'Approved for recovery test.'
    });

    let brokerCalls = 0;

    const broker = {
      filesystemBroker: {
        readFile: async () => ({
          path: args.path,
          content: 'before\n',
          size: 7
        })
      },
      execute: async call => {
        brokerCalls += 1;

        return {
          path: call.arguments.path,
          changed: true,
          newBytes: Buffer.byteLength(call.arguments.content, 'utf8')
        };
      }
    };

    const orchestrator = createOrchestrator({
      getTasks: async () => [],
      saveTasks: async () => {},
      getConfig: async () => ({
        allowWrites: false,
        allowedCommands: []
      }),
      toolBrokerFactory: async () => broker,
      modelAdapter: async () => {
        throw new Error('Model must not be invoked during recovery execution');
      },
      modelRouter: {},
      toolSpec: [],
      projectRoot: dir,
      emit: () => {},
      store
    });

    const originalConsume = store.consumeApprovalRequest.bind(store);

    store.consumeApprovalRequest = () => {
      throw new Error('Simulated crash window before approval consumption');
    };

    await assert.rejects(
      () =>
        orchestrator.executeApprovedAction({
          taskId,
          approvalId
        }),
      /Simulated crash window/
    );

    assert.equal(
      brokerCalls,
      1,
      'The approved mutation should execute exactly once before the simulated crash.'
    );

    assert.equal(
      store.getToolAction(actionId).status,
      'success',
      'Durable tool success must survive approval-consumption failure.'
    );

    assert.equal(
      store.getApprovalRequest(approvalId).status,
      'approved',
      'Approval must remain approved until consumption succeeds.'
    );

    store.consumeApprovalRequest = originalConsume;

    const retryResult = await orchestrator.executeApprovedAction({
      taskId,
      approvalId
    });

    assert.equal(
      brokerCalls,
      1,
      'Retry must consume the approval without executing the broker again.'
    );

    assert.equal(retryResult.approval.status, 'consumed');
    assert.equal(store.getToolAction(actionId).status, 'success');
  } finally {
    store?.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
