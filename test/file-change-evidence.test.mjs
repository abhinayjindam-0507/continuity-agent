import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { openStore, computeToolIdempotencyKey } from '../src/store.mjs';
import { createFilesystemBroker, DEFAULT_MAX_FILE_SIZE } from '../src/tools/filesystem-broker.mjs';
import { createToolBroker } from '../src/tools/tool-broker.mjs';
import {
  buildChangeEvidence,
  captureFileState,
  FILE_CHANGE_EVIDENCE_VERSION,
  MAX_EVIDENCE_CONTENT_BYTES,
  sha256Content
} from '../src/tools/change-evidence.mjs';
import { createOrchestrator } from '../src/orchestrator/orchestrator.mjs';

function sha256Of(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeTask(id) {
  return {
    id,
    goal: 'Exercise filesystem change evidence',
    status: 'queued',
    message: 'Waiting to start.',
    activeModel: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    checkpoints: [],
    switches: []
  };
}

// A permissive filesystem broker for exercising the success path: production
// policy still denies writes; these tests stub only the authorization hook
// while keeping every broker path/sensitive/size protection active.
function makePermissiveBroker(projectRoot) {
  return createFilesystemBroker({
    projectRoot,
    authorizeWrite: async () => true,
    authorizePatch: async () => true
  });
}

// Mirrors tool-broker's write/patch dispatch over the given broker (no policy
// layer, matching the permissive test broker).
function makeMutatingExecute(fsBroker) {
  return async call => {
    const args = call.arguments || {};
    if (call.name === 'write_file') {
      if (typeof args.content !== 'string') {
        throw new Error('write_file requires text content.');
      }
      return fsBroker.writeFile(args.path, args.content);
    }
    if (call.name === 'patch_file') {
      const patchSpec = args.patch || {
        targetContent: args.targetContent,
        replacementContent: args.replacementContent
      };
      return fsBroker.patchFile(args.path, patchSpec);
    }
    throw new Error(`Unknown tool: ${call.name}`);
  };
}

async function setupCase() {
  const fixture = await mkdtemp(join(tmpdir(), 'evidence-fixture-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'evidence-store-'));
  const store = await openStore(dataRoot);
  const fsBroker = makePermissiveBroker(fixture);

  return {
    fixture,
    dataRoot,
    store,
    fsBroker,
    cleanup: async () => {
      store.close();
      await rm(fixture, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  };
}

function makeOrchestrator({ store, orchestratorStore, fixture, fsBroker, execute, modelAdapter, config = {} }) {
  return createOrchestrator({
    getTasks: () => store.getTasks(),
    saveTasks: tasks => store.saveTasks(tasks),
    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel: 'test-model',
      fallbacks: [],
      maxSteps: 3,
      allowedCommands: [],
      networkToolsEnabled: false,
      allowWrites: false,
      ...config
    }),
    toolBrokerFactory: async () => ({
      execute: execute || makeMutatingExecute(fsBroker),
      filesystemBroker: fsBroker
    }),
    modelAdapter,
    toolSpec: [],
    projectRoot: fixture,
    emit: () => {},
    store: orchestratorStore || store
  });
}

function scriptedModelAdapter(calls) {
  let invocation = 0;
  return async () => {
    const next = calls[invocation];
    invocation += 1;
    return next;
  };
}

function toolCall(name, args) {
  // Matches the broker's arguments contract: an arguments object, which the
  // orchestrator also accepts directly for its own idempotency parsing.
  return {
    message: {
      tool_calls: [
        {
          id: `call-${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name, arguments: args }
        }
      ]
    }
  };
}

const finishMessage = { message: { content: 'done', tool_calls: [] } };

// ── Capture-level tests (through the real filesystem broker) ─────────────────

test('captureFileState represents a missing file explicitly as a missing before-state', async () => {
  const { fixture, fsBroker, cleanup } = await setupCase();
  try {
    const state = await captureFileState(fsBroker, 'nope.txt');
    assert.equal(state.present, false);
    assert.equal(state.readOutcome, 'not_found');
    assert.equal(state.contentIncluded, false);
    assert.equal(state.content, undefined);
    assert.equal(state.hash, undefined);
  } finally {
    await cleanup();
  }
});

test('captureFileState captures actual content with a correct SHA-256 hash', async () => {
  const { fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, 'app.txt'), 'hello evidence\n');
    const state = await captureFileState(fsBroker, 'app.txt');

    assert.equal(state.present, true);
    assert.equal(state.readOutcome, 'ok');
    assert.equal(state.contentIncluded, true);
    assert.equal(state.content, 'hello evidence\n');
    assert.equal(state.size, 15);
    assert.equal(state.hash, sha256Of('hello evidence\n'));
  } finally {
    await cleanup();
  }
});

test('captureFileState omits content beyond the evidence bound but keeps the full hash', async () => {
  const { fixture, fsBroker, cleanup } = await setupCase();
  try {
    const big = 'A'.repeat(MAX_EVIDENCE_CONTENT_BYTES + 1024);
    await writeFile(join(fixture, 'big.txt'), big);
    const state = await captureFileState(fsBroker, 'big.txt');

    assert.equal(state.present, true);
    assert.equal(state.readOutcome, 'ok');
    assert.equal(state.contentIncluded, false);
    assert.equal(state.content, undefined);
    assert.equal(state.hash, sha256Of(big));
    assert.ok(state.byteLength > MAX_EVIDENCE_CONTENT_BYTES);
  } finally {
    await cleanup();
  }
});

test('captureFileState marks broker-oversized files as size_exceeded without content or hash', async () => {
  const { fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, 'huge.txt'), 'B'.repeat(DEFAULT_MAX_FILE_SIZE + 1024));
    const state = await captureFileState(fsBroker, 'huge.txt');

    assert.equal(state.present, true);
    assert.equal(state.readOutcome, 'size_exceeded');
    assert.equal(state.contentIncluded, false);
    assert.equal(state.content, undefined);
    assert.equal(state.hash, undefined);
  } finally {
    await cleanup();
  }
});

test('captureFileState never captures sensitive file content', async () => {
  const { fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, '.env'), 'SUPER_SECRET_TOKEN=abc123\n');
    const state = await captureFileState(fsBroker, '.env');

    assert.equal(state.readOutcome, 'sensitive_blocked');
    assert.equal(state.contentIncluded, false);
    assert.equal(state.content, undefined);
    assert.equal(state.hash, undefined);
    assert.ok(!JSON.stringify(state).includes('SUPER_SECRET_TOKEN'));
  } finally {
    await cleanup();
  }
});

test('captureFileState refuses traversal without exposing host paths', async () => {
  const { fixture, fsBroker, cleanup } = await setupCase();
  try {
    const state = await captureFileState(fsBroker, '../../etc/hostname');
    assert.equal(state.present, false);
    assert.equal(state.readOutcome, 'unreadable');
    assert.equal(state.content, undefined);
    assert.ok(!JSON.stringify(state).includes('etc'));
    assert.ok(!JSON.stringify(state).includes(fixture));
  } finally {
    await cleanup();
  }
});

// ── Store-level tests (atomicity, idempotency, integrity, restart) ───────────

test('successful tool action and evidence persist atomically with verifiable hashes', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, 'notes.txt'), 'before content\n');
    const before = await captureFileState(fsBroker, 'notes.txt');

    const action = store.recordToolAction({
      taskId: 'task-ev-1',
      toolName: 'patch_file',
      args: { path: 'notes.txt', patch: { targetContent: 'before', replacementContent: 'after' } },
      status: 'pending'
    });

    // The actual mutation the tool action represents.
    await fsBroker.writeFile('notes.txt', 'after content\n');
    const after = await captureFileState(fsBroker, 'notes.txt');
    const evidence = buildChangeEvidence({
      toolActionId: action.id,
      idempotencyKey: action.idempotencyKey,
      taskId: 'task-ev-1',
      toolName: 'patch_file',
      relativePath: 'notes.txt',
      beforeState: before,
      afterState: after
    });

    const { action: completed, evidence: stored } = store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: '{"ok":true}',
      evidence
    });

    assert.equal(completed.status, 'success');
    assert.ok(stored);
    assert.equal(stored.evidenceVersion, FILE_CHANGE_EVIDENCE_VERSION);
    assert.equal(stored.operation, 'patch');
    assert.equal(stored.relativePath, 'notes.txt');
    assert.equal(stored.toolActionId, action.id);
    assert.equal(stored.idempotencyKey, action.idempotencyKey);
    assert.equal(stored.beforeHash, sha256Of('before content\n'));
    assert.equal(stored.afterHash, sha256Of('after content\n'));
    assert.equal(stored.beforeState.content, 'before content\n');
    assert.equal(stored.afterState.content, 'after content\n');

    const fetched = store.getToolActionEvidence(action.idempotencyKey);
    assert.equal(fetched.afterState.content, 'after content\n');
    assert.equal(fetched.beforeHash, stored.beforeHash);
  } finally {
    await cleanup();
  }
});

test('idempotent replay does not duplicate or conflict change evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, 'idem.txt'), 'v1\n');
    const action = store.recordToolAction({
      taskId: 'task-ev-2',
      toolName: 'write_file',
      args: { path: 'idem.txt', content: 'v2\n' },
      status: 'pending'
    });

    const before = await captureFileState(fsBroker, 'idem.txt');
    await fsBroker.writeFile('idem.txt', 'v2\n');
    const after = await captureFileState(fsBroker, 'idem.txt');
    const evidence = buildChangeEvidence({
      toolActionId: action.id,
      idempotencyKey: action.idempotencyKey,
      taskId: 'task-ev-2',
      toolName: 'write_file',
      relativePath: 'idem.txt',
      beforeState: before,
      afterState: after
    });

    const first = store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: '{"changed":true}',
      evidence
    });

    const second = store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: '{"changed":true}',
      evidence
    });

    assert.equal(second.evidence.id, first.evidence.id);
    assert.deepEqual(second.evidence.beforeState, first.evidence.beforeState);
    assert.deepEqual(second.evidence.afterState, first.evidence.afterState);

    const rows = store.database
      .prepare('SELECT COUNT(*) AS count FROM file_change_evidence WHERE idempotency_key = ?')
      .get(action.idempotencyKey);
    assert.equal(rows.count, 1);
  } finally {
    await cleanup();
  }
});

test('evidence persistence failure rolls back the success claim entirely', async () => {
  const { store, cleanup } = await setupCase();
  try {
    const action = store.recordToolAction({
      taskId: 'task-ev-3',
      toolName: 'write_file',
      args: { path: 'x.txt', content: 'data' },
      status: 'pending'
    });

    // Malformed evidence (missing required fields) must fail the whole transaction.
    assert.throws(
      () =>
        store.completeToolActionWithEvidence({
          actionRecord: action,
          resultSummary: '{"ok":true}',
          evidence: {
            toolActionId: action.id,
            idempotencyKey: action.idempotencyKey,
            taskId: 'task-ev-3',
            toolName: 'write_file',
            evidenceVersion: FILE_CHANGE_EVIDENCE_VERSION,
            beforeState: { present: false, readOutcome: 'not_found', contentIncluded: false },
            afterState: { present: true, readOutcome: 'ok', hash: sha256Of('data'), contentIncluded: true, content: 'data' }
          }
        }),
      /File change evidence requires/
    );

    // The success claim was rolled back: the action is not success, no evidence exists.
    const reloaded = store.getToolAction(action.idempotencyKey);
    assert.equal(reloaded.status, 'pending');
    assert.equal(store.getCompletedToolAction(action.idempotencyKey), null);
    assert.equal(store.getToolActionEvidence(action.idempotencyKey), null);
  } finally {
    await cleanup();
  }
});

test('evidence idempotency conflict handling: replay preserved, conflicting identity fails closed', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    // Seed one legitimate, successful evidence row.
    await writeFile(join(fixture, 'a.txt'), 'legitimate\n');
    const action = store.recordToolAction({
      taskId: 'task-conflict-1',
      toolName: 'write_file',
      args: { path: 'a.txt', content: 'legitimate\n' },
      status: 'pending'
    });
    const before = await captureFileState(fsBroker, 'a.txt');
    await fsBroker.writeFile('a.txt', 'legitimate\n');
    const after = await captureFileState(fsBroker, 'a.txt');
    const legitimate = buildChangeEvidence({
      toolActionId: action.id,
      idempotencyKey: action.idempotencyKey,
      taskId: 'task-conflict-1',
      toolName: 'write_file',
      relativePath: 'a.txt',
      beforeState: before,
      afterState: after
    });
    const seeded = store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: null,
      evidence: legitimate
    });
    assert.ok(seeded.evidence);

    // Legitimate replay: identical identity returns the same row, no duplicate.
    const replayed = store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: null,
      evidence: buildChangeEvidence({
        toolActionId: action.id,
        idempotencyKey: action.idempotencyKey,
        taskId: 'task-conflict-1',
        toolName: 'write_file',
        relativePath: 'a.txt',
        beforeState: before,
        afterState: after
      })
    });
    assert.equal(replayed.evidence.id, seeded.evidence.id);

    // Conflicting identity per field must fail closed.
    for (const override of [
      { toolActionId: 'rogue-action-id' },
      { taskId: 'task-conflict-other' },
      { toolName: 'patch_file' },
      { relativePath: 'not-a.txt' }
    ]) {
      assert.throws(
        () =>
          store.completeToolActionWithEvidence({
            actionRecord: action,
            resultSummary: null,
            evidence: { ...legitimate, ...override }
          }),
        { message: /File change evidence idempotency conflict/ }
      );
    }

    // The original evidence and action are untouched by the rejected attempts.
    const rows = store.database
      .prepare('SELECT COUNT(*) AS count FROM file_change_evidence WHERE idempotency_key = ?')
      .get(action.idempotencyKey);
    assert.equal(rows.count, 1);
    const intact = store.getToolActionEvidence(action.idempotencyKey);
    assert.equal(intact.toolActionId, action.id);
    assert.equal(intact.taskId, 'task-conflict-1');
    assert.equal(intact.toolName, 'write_file');
    assert.equal(intact.operation, 'write');
    assert.equal(intact.relativePath, 'a.txt');
    assert.equal(store.getToolAction(action.idempotencyKey).status, 'success');

    // A distinct pending action whose completion reuses the occupied key with a
    // conflicting toolActionId rolls back its success claim entirely.
    const rogueAction = store.recordToolAction({
      taskId: 'task-conflict-1',
      toolName: 'write_file',
      args: { path: 'rogue.txt', content: 'r' },
      status: 'pending'
    });
    assert.throws(
      () =>
        store.completeToolActionWithEvidence({
          actionRecord: rogueAction,
          resultSummary: null,
          evidence: {
            ...legitimate,
            idempotencyKey: action.idempotencyKey,
            toolActionId: rogueAction.id
          }
        }),
      { message: /File change evidence idempotency conflict/ }
    );
    assert.equal(store.getToolAction(rogueAction.idempotencyKey).status, 'pending');
    assert.equal(store.getToolActionEvidence(rogueAction.idempotencyKey), null);
  } finally {
    await cleanup();
  }
});

test('operation identity conflict: write evidence rejects same-key patch attempt and rolls back', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    // Seed a legitimate, successful write_file evidence row.
    await writeFile(join(fixture, 'op.txt'), 'written\n');
    const action = store.recordToolAction({
      taskId: 'task-op-conflict',
      toolName: 'write_file',
      args: { path: 'op.txt', content: 'written\n' },
      status: 'pending'
    });
    const before = await captureFileState(fsBroker, 'op.txt');
    await fsBroker.writeFile('op.txt', 'written\n');
    const after = await captureFileState(fsBroker, 'op.txt');
    const seeded = store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: null,
      evidence: buildChangeEvidence({
        toolActionId: action.id,
        idempotencyKey: action.idempotencyKey,
        taskId: 'task-op-conflict',
        toolName: 'write_file',
        relativePath: 'op.txt',
        beforeState: before,
        afterState: after
      })
    });
    assert.equal(seeded.evidence.operation, 'write');

    // A distinct pending action attempts to complete against the occupied key
    // with evidence whose only identity difference is operation: patch.
    const conflictingAction = store.recordToolAction({
      taskId: 'task-op-conflict',
      toolName: 'patch_file',
      args: { path: 'op.txt', patch: { targetContent: 'written', replacementContent: 'edited' } },
      status: 'pending'
    });
    assert.throws(
      () =>
        store.completeToolActionWithEvidence({
          actionRecord: conflictingAction,
          resultSummary: null,
          evidence: {
            toolActionId: action.id,
            idempotencyKey: action.idempotencyKey,
            taskId: 'task-op-conflict',
            toolName: 'write_file',
            operation: 'patch',
            relativePath: 'op.txt',
            evidenceVersion: FILE_CHANGE_EVIDENCE_VERSION,
            beforeState: before,
            afterState: after
          }
        }),
      { message: /File change evidence idempotency conflict: operation does not match/ }
    );

    // The conflicting action's success transition rolled back: no success, no evidence.
    assert.equal(store.getToolAction(conflictingAction.idempotencyKey).status, 'pending');
    assert.equal(store.getCompletedToolAction(conflictingAction.idempotencyKey), null);
    assert.equal(store.getToolActionEvidence(conflictingAction.idempotencyKey), null);

    // The original write evidence is unchanged and remains the only row for the key.
    const intact = store.getToolActionEvidence(action.idempotencyKey);
    assert.equal(intact.operation, 'write');
    assert.equal(intact.toolActionId, action.id);
    assert.equal(intact.afterState.content, 'written\n');
    assert.equal(intact.afterHash, sha256Of('written\n'));
    const rows = store.database
      .prepare('SELECT COUNT(*) AS count FROM file_change_evidence WHERE idempotency_key = ?')
      .get(action.idempotencyKey);
    assert.equal(rows.count, 1);
    assert.equal(store.getToolAction(action.idempotencyKey).status, 'success');
  } finally {
    await cleanup();
  }
});

test('restart persistence keeps evidence consistent with its successful tool action', async () => {
  const { store, dataRoot, fixture, fsBroker, cleanup } = await setupCase();
  let reopened;
  try {
    await writeFile(join(fixture, 'keep.txt'), 'restart before');
    const action = store.recordToolAction({
      taskId: 'task-ev-4',
      toolName: 'write_file',
      args: { path: 'keep.txt', content: 'restart after' },
      status: 'pending'
    });
    const before = await captureFileState(fsBroker, 'keep.txt');
    await fsBroker.writeFile('keep.txt', 'restart after');
    const after = await captureFileState(fsBroker, 'keep.txt');

    store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: '{"changed":true}',
      evidence: buildChangeEvidence({
        toolActionId: action.id,
        idempotencyKey: action.idempotencyKey,
        taskId: 'task-ev-4',
        toolName: 'write_file',
        relativePath: 'keep.txt',
        beforeState: before,
        afterState: after
      })
    });

    // A second, interrupted action stays pending across restart.
    store.recordToolAction({
      taskId: 'task-ev-4',
      toolName: 'write_file',
      args: { path: 'other.txt', content: 'x' },
      status: 'pending'
    });

    store.close();
    reopened = await openStore(dataRoot);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }

  try {
    const row = reopened.database
      .prepare('SELECT idempotency_key AS idempotencyKey FROM file_change_evidence')
      .all()[0];
    const evidence = reopened.getToolActionEvidence(row.idempotencyKey);
    const action = reopened.getToolAction(evidence.idempotencyKey);
    assert.equal(action.status, 'success');
    assert.equal(evidence.afterState.content, 'restart after');

    // Interrupted action recovered to needs_verification; it has no evidence.
    const pending = reopened.database
      .prepare("SELECT status FROM tool_actions WHERE arguments LIKE '%other.txt%'")
      .get();
    assert.equal(pending.status, 'needs_verification');
    assert.equal(reopened.getToolActionEvidence(computeToolIdempotencyKey({
      taskId: 'task-ev-4',
      toolName: 'write_file',
      args: { path: 'other.txt', content: 'x' }
    })), null);
  } finally {
    reopened.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('every evidence row is joined to a successful tool action', async () => {
  const { store, cleanup } = await setupCase();
  try {
    const action = store.recordToolAction({
      taskId: 'task-ev-5',
      toolName: 'write_file',
      args: { path: 'ok.txt', content: 'ok' },
      status: 'pending'
    });
    store.completeToolActionWithEvidence({
      actionRecord: action,
      resultSummary: null,
      evidence: buildChangeEvidence({
        toolActionId: action.id,
        idempotencyKey: action.idempotencyKey,
        taskId: 'task-ev-5',
        toolName: 'write_file',
        relativePath: 'ok.txt',
        beforeState: { present: false, readOutcome: 'not_found', contentIncluded: false },
        afterState: { present: true, readOutcome: 'ok', hash: sha256Of('ok'), contentIncluded: true, content: 'ok' }
      })
    });

    const rows = store.database.prepare(`
      SELECT e.id, a.status
      FROM file_change_evidence e
      JOIN tool_actions a ON a.idempotency_key = e.idempotency_key
    `).all();
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.equal(row.status, 'success');
    }
  } finally {
    await cleanup();
  }
});

// ── Orchestrator lifecycle tests ──────────────────────────────────────────────

test('new-file write records missing before-state and actual after-state evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await store.upsertTask(makeTask('task-run-1'));
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: 'created.txt', content: 'brand new\n' }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-1');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-1',
      toolName: 'write_file',
      args: { path: 'created.txt', content: 'brand new\n' }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'success');

    const evidence = store.getToolActionEvidence(key);
    assert.ok(evidence);
    assert.equal(evidence.operation, 'write');
    assert.equal(evidence.relativePath, 'created.txt');
    assert.equal(evidence.beforeState.present, false);
    assert.equal(evidence.beforeState.readOutcome, 'not_found');
    assert.equal(evidence.afterState.present, true);
    assert.equal(evidence.afterState.content, 'brand new\n');
    assert.equal(evidence.afterHash, sha256Of('brand new\n'));
  } finally {
    await cleanup();
  }
});

test('existing-file write records actual before/after states with distinct hashes', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, 'existing.txt'), 'original\n');
    await store.upsertTask(makeTask('task-run-2'));
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: 'existing.txt', content: 'replaced\n' }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-2');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-2',
      toolName: 'write_file',
      args: { path: 'existing.txt', content: 'replaced\n' }
    });
    const evidence = store.getToolActionEvidence(key);
    assert.ok(evidence);
    assert.equal(evidence.beforeState.content, 'original\n');
    assert.equal(evidence.afterState.content, 'replaced\n');
    assert.equal(evidence.beforeHash, sha256Of('original\n'));
    assert.equal(evidence.afterHash, sha256Of('replaced\n'));
    assert.notEqual(evidence.beforeHash, evidence.afterHash);
  } finally {
    await cleanup();
  }
});

test('successful patch records the actual pre-patch content as before-state', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, 'code.js'), 'const a = 1;\nconst b = 2;\n');
    await store.upsertTask(makeTask('task-run-3'));
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('patch_file', {
          path: 'code.js',
          patch: { targetContent: 'const b = 2;', replacementContent: 'const b = 3;' }
        }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-3');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-3',
      toolName: 'patch_file',
      args: { path: 'code.js', patch: { targetContent: 'const b = 2;', replacementContent: 'const b = 3;' } }
    });
    const evidence = store.getToolActionEvidence(key);
    assert.ok(evidence);
    assert.equal(evidence.operation, 'patch');
    assert.equal(evidence.beforeState.content, 'const a = 1;\nconst b = 2;\n');
    assert.equal(evidence.afterState.content, 'const a = 1;\nconst b = 3;\n');
    assert.equal(evidence.beforeHash, sha256Of('const a = 1;\nconst b = 2;\n'));
    assert.equal(evidence.afterHash, sha256Of('const a = 1;\nconst b = 3;\n'));
  } finally {
    await cleanup();
  }
});

test('failed patch creates no successful change evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await writeFile(join(fixture, 'plain.txt'), 'unchanged\n');
    await store.upsertTask(makeTask('task-run-4'));
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('patch_file', {
          path: 'plain.txt',
          patch: { targetContent: 'does not exist', replacementContent: 'x' }
        }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-4');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-4',
      toolName: 'patch_file',
      args: { path: 'plain.txt', patch: { targetContent: 'does not exist', replacementContent: 'x' } }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'failure');
    assert.equal(store.getToolActionEvidence(key), null);

    const content = await fsBroker.readFile('plain.txt');
    assert.equal(content.content, 'unchanged\n');
  } finally {
    await cleanup();
  }
});

test('policy-denied write creates no change evidence', async () => {
  const { store, fixture, cleanup } = await setupCase();
  try {
    // Real tool broker with production config: writes are denied.
    const realBroker = createToolBroker(fixture, {
      allowedCommands: [],
      allowWrites: false
    });
    await store.upsertTask(makeTask('task-run-5'));
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker: realBroker.filesystemBroker,
      execute: call => realBroker.execute(call),
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: 'denied.txt', content: 'nope' }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-5');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-5',
      toolName: 'write_file',
      args: { path: 'denied.txt', content: 'nope' }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'failure');
    assert.match(action.error, /denied|approval/i);
    assert.equal(store.getToolActionEvidence(key), null);
  } finally {
    await cleanup();
  }
});

test('aborted operation creates no successful change evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await store.upsertTask(makeTask('task-run-6'));

    let releaseExecute;
    const gate = new Promise(resolve => { releaseExecute = resolve; });
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      execute: async () => {
        await gate;
        return { path: 'aborted.txt', changed: true };
      },
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: 'aborted.txt', content: 'partial' }),
        finishMessage
      ])
    });

    const runPromise = orchestrator.runTask('task-run-6');
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const poll = setInterval(() => {
        const action = store.database
          .prepare("SELECT status FROM tool_actions WHERE task_id = 'task-run-6'")
          .get();
        if (action) {
          clearInterval(poll);
          resolve();
        } else if (++attempts > 500) {
          clearInterval(poll);
          reject(new Error('Tool action row never appeared'));
        }
      }, 10);
    });

    const pausePromise = orchestrator.pauseTask('task-run-6');
    releaseExecute();
    await runPromise;
    await pausePromise;

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-6',
      toolName: 'write_file',
      args: { path: 'aborted.txt', content: 'partial' }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'failure');
    assert.match(action.error, /aborted/i);
    assert.equal(store.getToolActionEvidence(key), null);
  } finally {
    await cleanup();
  }
});

test('sensitive file write is rejected by the broker and creates no evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await store.upsertTask(makeTask('task-run-7'));
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: '.env', content: 'SECRET=1' }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-7');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-7',
      toolName: 'write_file',
      args: { path: '.env', content: 'SECRET=1' }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'failure');
    assert.match(action.error, /sensitive/i);
    assert.equal(store.getToolActionEvidence(key), null);
  } finally {
    await cleanup();
  }
});

test('traversal write is rejected and creates no evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await store.upsertTask(makeTask('task-run-8'));
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: '../escape.txt', content: 'nope' }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-8');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-8',
      toolName: 'write_file',
      args: { path: '../escape.txt', content: 'nope' }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'failure');
    assert.match(action.error, /traversal|sensitive/i);
    assert.equal(store.getToolActionEvidence(key), null);
  } finally {
    await cleanup();
  }
});

test('oversized write fails broker size enforcement and creates no evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await store.upsertTask(makeTask('task-run-9'));
    const oversized = 'x'.repeat(DEFAULT_MAX_FILE_SIZE + 10);
    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: 'toobig.txt', content: oversized }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-9');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-9',
      toolName: 'write_file',
      args: { path: 'toobig.txt', content: oversized }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'failure');
    assert.match(action.error, /exceeds maximum allowed limit/);
    assert.equal(store.getToolActionEvidence(key), null);
  } finally {
    await cleanup();
  }
});

test('evidence persistence failure parks the action in needs_verification without evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await store.upsertTask(makeTask('task-run-10'));
    const failingStore = {
      recordToolAction: (...args) => store.recordToolAction(...args),
      getCompletedToolAction: (...args) => store.getCompletedToolAction(...args),
      completeToolActionWithEvidence: () => {
        throw new Error('simulated evidence storage failure');
      }
    };

    const orchestrator = makeOrchestrator({
      store,
      orchestratorStore: failingStore,
      fixture,
      fsBroker,
      modelAdapter: scriptedModelAdapter([
        toolCall('write_file', { path: 'unverified.txt', content: 'written\n' }),
        finishMessage
      ])
    });

    await orchestrator.runTask('task-run-10');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-10',
      toolName: 'write_file',
      args: { path: 'unverified.txt', content: 'written\n' }
    });
    const action = store.getToolAction(key);
    assert.equal(action.status, 'needs_verification');
    assert.match(action.error, /evidence could not be persisted/);
    assert.equal(store.getToolActionEvidence(key), null);
  } finally {
    await cleanup();
  }
});

test('replayed completed tool action does not duplicate change evidence', async () => {
  const { store, fixture, fsBroker, cleanup } = await setupCase();
  try {
    await store.upsertTask(makeTask('task-run-11'));

    let invocation = 0;
    const modelAdapter = async () => {
      invocation += 1;
      if (invocation === 1) {
        return toolCall('write_file', { path: 'replay.txt', content: 'same content\n' });
      }
      // Second step replays the identical action (deterministic recovery path).
      return toolCall('write_file', { path: 'replay.txt', content: 'same content\n' });
    };

    const orchestrator = makeOrchestrator({
      store,
      fixture,
      fsBroker,
      modelAdapter
    });

    await orchestrator.runTask('task-run-11');

    const key = computeToolIdempotencyKey({
      taskId: 'task-run-11',
      toolName: 'write_file',
      args: { path: 'replay.txt', content: 'same content\n' }
    });
    const rows = store.database
      .prepare('SELECT COUNT(*) AS count FROM file_change_evidence WHERE idempotency_key = ?')
      .get(key);
    assert.equal(rows.count, 1);
    assert.equal(store.getToolAction(key).status, 'success');
  } finally {
    await cleanup();
  }
});
