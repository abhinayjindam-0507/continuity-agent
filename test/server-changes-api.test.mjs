import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, rm as rmFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { before, after, test } from 'node:test';

import { openStore, computeToolIdempotencyKey } from '../src/store.mjs';
import { createFilesystemBroker } from '../src/tools/filesystem-broker.mjs';
import { captureFileState, buildChangeEvidence } from '../src/tools/change-evidence.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const TASK_ID = 'task-diff-api';

let dataRoot;
let projectDir;
let serverProcess;
let port;
let seedStore;
let fsBroker;

async function seedEvidence({
  toolName = 'write_file',
  relativePath,
  beforeSource,
  afterSource,
  capturedAt,
  actionArgsContent = 'seed'
}) {
  const action = seedStore.recordToolAction({
    taskId: TASK_ID,
    toolName,
    args: { path: relativePath, content: actionArgsContent },
    status: 'pending'
  });

  const beforeState = await beforeSource();
  const afterState = await afterSource();

  return seedStore.completeToolActionWithEvidence({
    actionRecord: action,
    resultSummary: '{"seeded":true}',
    evidence: buildChangeEvidence({
      toolActionId: action.id,
      idempotencyKey: action.idempotencyKey,
      taskId: TASK_ID,
      toolName,
      relativePath,
      beforeState,
      afterState,
      ...(capturedAt ? { capturedAt } : {})
    })
  });
}

const capture = relativePath => () => captureFileState(fsBroker, relativePath);
const missing = () => ({ present: false, readOutcome: 'not_found', contentIncluded: false });

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
    serverProcess.stdout.on('data', chunk => { stdout += chunk; });
    serverProcess.stderr.on('data', chunk => { stderr += chunk; });
    serverProcess.on('exit', code => {
      rejectPromise(new Error(`Server exited early (${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });

    const poll = async attemptsLeft => {
      if (attemptsLeft <= 0) {
        rejectPromise(new Error(`Server never became ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/api/models`);
        if (probe.ok) { resolvePromise(); return; }
      } catch { /* not ready yet */ }
      setTimeout(() => poll(attemptsLeft - 1), 100);
    };
    poll(150);
  });
}

before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'changes-api-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'changes-api-project-'));
  seedStore = await openStore(dataRoot);
  fsBroker = createFilesystemBroker({ projectRoot: projectDir });

  await seedStore.upsertTask({
    id: TASK_ID,
    goal: 'Diff API verification task',
    status: 'completed',
    message: 'done',
    activeModel: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    steps: [],
    checkpoints: [],
    switches: []
  });

  // 1. created file (missing before-state, included after-state)
  await writeFile(join(projectDir, 'src-new.js'), 'export const n = 1;\n');
  await seedEvidence({
    relativePath: 'src-new.js',
    beforeSource: missing,
    afterSource: capture('src-new.js'),
    capturedAt: '2026-01-01T00:01:00.000Z'
  });

  // 2. modified file
  await writeFile(join(projectDir, 'app.js'), 'const a = 1;\nconst b = 2;\n');
  await seedEvidence({
    relativePath: 'app.js',
    beforeSource: capture('app.js'),
    afterSource: async () => {
      await writeFile(join(projectDir, 'app.js'), 'const a = 1;\nconst b = 3;\n');
      return captureFileState(fsBroker, 'app.js');
    },
    capturedAt: '2026-01-01T00:02:00.000Z'
  });

  // 3. deleted file (included before-state, missing after-state)
  await writeFile(join(projectDir, 'gone.md'), 'delete me\n');
  await seedEvidence({
    toolName: 'patch_file',
    relativePath: 'gone.md',
    beforeSource: capture('gone.md'),
    afterSource: async () => {
      await rmFile(join(projectDir, 'gone.md'));
      return captureFileState(fsBroker, 'gone.md');
    },
    capturedAt: '2026-01-01T00:03:00.000Z'
  });

  // 4. unchanged file
  await writeFile(join(projectDir, 'same.txt'), 'identical\n');
  await seedEvidence({
    relativePath: 'same.txt',
    beforeSource: capture('same.txt'),
    afterSource: capture('same.txt'),
    capturedAt: '2026-01-01T00:04:00.000Z'
  });

  // 5. created empty file (empty content must differ from missing before)
  await writeFile(join(projectDir, 'empty.txt'), '');
  await seedEvidence({
    relativePath: 'empty.txt',
    beforeSource: missing,
    afterSource: capture('empty.txt'),
    capturedAt: '2026-01-01T00:05:00.000Z'
  });

  // 6. content omitted under the evidence bound (crafted > 64 KB state)
  await seedEvidence({
    relativePath: 'big.txt',
    beforeSource: missing,
    afterSource: async () => {
      const big = 'B'.repeat(70_000);
      const { MAX_EVIDENCE_CONTENT_BYTES, sha256Content } =
        await import('../src/tools/change-evidence.mjs');
      return {
        present: true,
        readOutcome: 'ok',
        size: big.length,
        byteLength: big.length,
        hash: sha256Content(big),
        contentIncluded: false,
        contentOmittedReason: `exceeds evidence bound of ${MAX_EVIDENCE_CONTENT_BYTES}`
      };
    },
    capturedAt: '2026-01-01T00:06:00.000Z'
  });

  // 7. sensitive/blocked state both sides
  await writeFile(join(projectDir, '.env'), 'SECRET_VALUE=do-not-leak\n');
  await seedEvidence({
    toolName: 'patch_file',
    relativePath: '.env',
    beforeSource: capture('.env'),
    afterSource: capture('.env'),
    capturedAt: '2026-01-01T00:07:00.000Z'
  });

  // 8. oversized (broker read limit) before-state with included after
  await seedEvidence({
    relativePath: 'huge.txt',
    beforeSource: async () => ({
      present: true,
      readOutcome: 'size_exceeded',
      contentIncluded: false
    }),
    afterSource: async () => {
      await writeFile(join(projectDir, 'huge.txt'), 'small now\n');
      return captureFileState(fsBroker, 'huge.txt');
    },
    capturedAt: '2026-01-01T00:08:00.000Z'
  });

  await startServer();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => {});
  }
  try { seedStore?.close(); } catch { /* already closed or broken */ }
  await rm(dataRoot, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function request(target) {
  const response = await fetch(`http://127.0.0.1:${port}${target}`);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, text, body };
}

function assertNoInternals(text) {
  for (const secret of [dataRoot, projectDir, tmpdir(), 'SECRET_VALUE', 'SQLite', 'sqlite:', 'SELECT']) {
    assert.ok(!text.includes(secret), `response leaked internal detail: ${secret}`);
  }
}

function changeFor(body, path) {
  return body.changes.find(change => change.path === path);
}

test('GET returns persisted created-file evidence with authentic after-state', async () => {
  const { status, body, text } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.taskId, TASK_ID);
  assert.equal(body.count, 8);
  assert.equal(body.total, 8);
  assert.equal(body.truncated, false);
  assertNoInternals(text);

  const created = changeFor(body, 'src-new.js');
  assert.equal(created.changeType, 'created');
  assert.equal(created.before.contentState, 'absent');
  assert.equal(created.before.present, false);
  assert.equal(created.after.contentState, 'included');
  assert.equal(created.after.content, 'export const n = 1;\n');
  assert.ok(created.afterHash);
  assert.equal(created.diff.kind, 'lines');
  assert.deepEqual(created.diff.lines, [
    { type: 'add', before: null, after: 1, text: 'export const n = 1;' }
  ]);
});

test('GET returns persisted modified-file evidence with real before/after lines', async () => {
  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const modified = changeFor(body, 'app.js');

  assert.equal(modified.changeType, 'modified');
  assert.equal(modified.before.content, 'const a = 1;\nconst b = 2;\n');
  assert.equal(modified.after.content, 'const a = 1;\nconst b = 3;\n');
  assert.notEqual(modified.beforeHash, modified.afterHash);
  assert.deepEqual(modified.diff.lines, [
    { type: 'context', before: 1, after: 1, text: 'const a = 1;' },
    { type: 'del', before: 2, after: null, text: 'const b = 2;' },
    { type: 'add', before: null, after: 2, text: 'const b = 3;' }
  ]);
});

test('GET returns persisted deleted-file evidence with explicit missing after-state', async () => {
  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const deleted = changeFor(body, 'gone.md');

  assert.equal(deleted.changeType, 'deleted');
  assert.equal(deleted.before.content, 'delete me\n');
  assert.equal(deleted.after.contentState, 'absent');
  assert.equal(deleted.after.present, false);
  assert.equal(deleted.afterHash, null);
  assert.deepEqual(deleted.diff.lines, [
    { type: 'del', before: 1, after: null, text: 'delete me' }
  ]);
});

test('unchanged evidence is represented as unchanged without diff lines', async () => {
  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const unchanged = changeFor(body, 'same.txt');

  assert.equal(unchanged.changeType, 'unchanged');
  assert.equal(unchanged.beforeHash, unchanged.afterHash);
  assert.deepEqual(unchanged.diff, { kind: 'none', reason: 'unchanged' });
});

test('missing before-state is distinguished from empty after-file content', async () => {
  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const empty = changeFor(body, 'empty.txt');

  assert.equal(empty.changeType, 'created');
  assert.equal(empty.before.contentState, 'absent');
  assert.equal(empty.after.contentState, 'included');
  assert.equal(empty.after.content, '');
  assert.equal(empty.after.byteLength, 0);
  assert.equal(empty.diff.kind, 'lines');
  assert.equal(empty.diff.lines.length, 0);
  assert.ok(empty.afterHash);
});

test('content omitted under the evidence bound is explicit, not empty, and hashes are kept', async () => {
  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const big = changeFor(body, 'big.txt');

  assert.equal(big.before.contentState, 'absent');
  assert.equal(big.after.contentState, 'omitted_evidence_bound');
  assert.equal(big.after.content, undefined);
  assert.equal(big.after.byteLength, 70_000);
  assert.ok(big.afterHash);
  assert.equal(big.diff.kind, 'none');
  assert.equal(big.diff.reason, 'content_unavailable_after');
});

test('sensitive/blocked evidence exposes no content', async () => {
  const { body, text } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const env = changeFor(body, '.env');

  assert.equal(env.before.contentState, 'blocked_sensitive');
  assert.equal(env.after.contentState, 'blocked_sensitive');
  assert.equal(env.changeType, 'metadata_only');
  assert.equal(env.diff.reason, 'hashes_unavailable');
  assert.ok(!text.includes('SECRET_VALUE'));
  assert.ok(!('content' in env.before));
});

test('oversized/broker-blocked before-state exposes no content and no invented hash', async () => {
  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const huge = changeFor(body, 'huge.txt');

  assert.equal(huge.before.contentState, 'oversized_broker_limit');
  assert.equal(huge.before.hash, null);
  assert.equal(huge.beforeHash, null);
  assert.equal(huge.after.content, 'small now\n');
  assert.equal(huge.changeType, 'metadata_only');
  assert.equal(huge.diff.kind, 'none');
});

test('diff API reports durable evidence even after physical files change or vanish', async () => {
  // Mutate and delete the underlying files AFTER evidence was captured.
  await writeFile(join(projectDir, 'app.js'), 'COMPLETELY DIFFERENT CURRENT CONTENT\n');
  await rmFile(join(projectDir, 'src-new.js'));
  await rmFile(join(projectDir, 'same.txt'));
  await rmFile(join(projectDir, 'empty.txt'));

  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);

  const app = changeFor(body, 'app.js');
  assert.equal(app.before.content, 'const a = 1;\nconst b = 2;\n');
  assert.equal(app.after.content, 'const a = 1;\nconst b = 3;\n');
  assert.equal(app.changeType, 'modified');

  const created = changeFor(body, 'src-new.js');
  assert.equal(created.after.content, 'export const n = 1;\n');
  assert.equal(created.changeType, 'created');

  const unchanged = changeFor(body, 'same.txt');
  assert.equal(unchanged.changeType, 'unchanged');
});

test('identical requests return byte-identical responses (determinism)', async () => {
  const first = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const second = await request(`/api/project/changes?taskId=${TASK_ID}`);
  assert.equal(first.text, second.text);
});

test('results use deterministic capture ordering', async () => {
  const { body } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  const paths = body.changes.map(change => change.path);
  assert.deepEqual(paths, [
    'src-new.js', 'app.js', 'gone.md', 'same.txt', 'empty.txt', 'big.txt', '.env', 'huge.txt'
  ]);
});

test('bounded result count with explicit truncation flag', async () => {
  const limited = await request(`/api/project/changes?taskId=${TASK_ID}&limit=3`);
  assert.equal(limited.status, 200);
  assert.equal(limited.body.limit, 3);
  assert.equal(limited.body.count, 3);
  assert.equal(limited.body.total, 8);
  assert.equal(limited.body.truncated, true);
  assert.equal(limited.body.changes.length, 3);

  const full = await request(`/api/project/changes?taskId=${TASK_ID}&limit=50`);
  assert.equal(full.body.truncated, false);
  assert.equal(full.body.count, 8);
});

test('oversized caller limit is clamped to the hard maximum', async () => {
  const { status, body } = await request(`/api/project/changes?taskId=${TASK_ID}&limit=999999`);
  assert.equal(status, 200);
  assert.equal(body.limit, 200);
});

test('invalid limits fall back to the safe default', async () => {
  for (const invalid of ['abc', '-5', '0', '2.5', '']) {
    const { status, body } =
      await request(`/api/project/changes?taskId=${TASK_ID}&limit=${encodeURIComponent(invalid)}`);
    assert.equal(status, 200, `limit=${invalid} must not error`);
    assert.equal(body.limit, 50, `limit=${invalid} must clamp to default`);
  }
});

test('missing and invalid task identifiers are rejected cleanly', async () => {
  const noTask = await request('/api/project/changes');
  assert.equal(noTask.status, 400);
  assert.match(noTask.body.error, /taskId/);

  const emptyTask = await request('/api/project/changes?taskId=');
  assert.equal(emptyTask.status, 400);

  const unknown = await request('/api/project/changes?taskId=does-not-exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'Task not found.');
});

test('path filter matches exactly and never resolves against the filesystem', async () => {
  const filtered = await request(`/api/project/changes?taskId=${TASK_ID}&path=app.js`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.count, 1);
  assert.equal(filtered.body.path, 'app.js');
  assert.equal(filtered.body.changes[0].path, 'app.js');

  const nested = await request(`/api/project/changes?taskId=${TASK_ID}&path=${encodeURIComponent('src/app.js')}`);
  assert.equal(nested.status, 200);
  assert.equal(nested.body.count, 0);
  assert.equal(nested.body.total, 0);
});

test('path filter abuse is rejected without escaping project scope', async () => {
  for (const abuse of [
    '..', '../..', '..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f', '/etc/passwd',
    'src/../app.js', '.env', 'src/.git/config', 'a//b', 'a/./b'
  ]) {
    const { status, body } =
      await request(`/api/project/changes?taskId=${TASK_ID}&path=${abuse}`);
    assert.equal(status, 400, `path=${abuse} must be rejected`);
    assert.match(body.error, /Invalid path filter/);
    assertNoInternals(JSON.stringify(body));
  }

  const nullByte = await request(`/api/project/changes?taskId=${TASK_ID}&path=app.js%00`);
  assert.equal(nullByte.status, 400);
});

test('Windows path and traversal forms are rejected fail-closed, while valid paths remain accepted', async () => {
  const windowsAbuseForms = [
    '..\\secret',
    'foo\\..\\secret',
    '.\\secret',
    'foo\\.\\bar',
    '\\secret',
    '\\\\server\\share',
    'C:\\secret'
  ];

  for (const abuse of windowsAbuseForms) {
    const { status, body } =
      await request(`/api/project/changes?taskId=${TASK_ID}&path=${encodeURIComponent(abuse)}`);
    assert.equal(status, 400, `Windows path=${abuse} must be rejected with 400`);
    assert.match(body.error, /Invalid path filter/);
    assertNoInternals(JSON.stringify(body));
  }

  // Confirm existing valid project-relative paths remain accepted.
  for (const validPath of [
    'src/index.html',
    'src/tools/change-diff.mjs',
    'test/example.test.mjs'
  ]) {
    const { status, body } =
      await request(`/api/project/changes?taskId=${TASK_ID}&path=${encodeURIComponent(validPath)}`);
    assert.equal(status, 200, `valid path=${validPath} must return 200`);
    assert.equal(body.ok, true);
    assert.equal(body.path, validPath);
  }
});

test('GET performs no mutation: database contents are identical after reads', async () => {
  const snapshot = () => JSON.stringify({
    evidence: seedStore.database.prepare('SELECT * FROM file_change_evidence ORDER BY rowid').all(),
    actions: seedStore.database.prepare('SELECT * FROM tool_actions ORDER BY rowid').all(),
    tasks: seedStore.database.prepare('SELECT * FROM tasks ORDER BY rowid').all(),
    checkpoints: seedStore.database.prepare('SELECT COUNT(*) AS c FROM checkpoints').get().c
  });

  const before = snapshot();
  await request(`/api/project/changes?taskId=${TASK_ID}`);
  await request(`/api/project/changes?taskId=${TASK_ID}&limit=2&path=app.js`);
  const after = snapshot();

  assert.equal(after, before);
});

test('malformed persisted evidence fails safely as metadata-only, never a fake diff', async () => {
  const row = seedStore.database
    .prepare('SELECT id FROM file_change_evidence WHERE relative_path = ?')
    .get('same.txt');
  seedStore.database
    .prepare('UPDATE file_change_evidence SET before_state = ? WHERE id = ?')
    .run('{"broken json', row.id);

  const { status, body } = await request(`/api/project/changes?taskId=${TASK_ID}&path=same.txt`);
  assert.equal(status, 200);
  const malformed = body.changes[0];
  assert.equal(malformed.integrity, 'malformed');
  assert.ok(malformed.integrityIssues.includes('before_state_unparsable'));
  assert.equal(malformed.changeType, 'metadata_only');
  assert.deepEqual(malformed.diff, { kind: 'none', reason: 'evidence_malformed' });

  // Restore for subsequent tests.
  seedStore.database
    .prepare('UPDATE file_change_evidence SET before_state = ? WHERE id = ?')
    .run(JSON.stringify({ present: true, readOutcome: 'ok', size: 11, byteLength: 11, hash: malformed.beforeHash, contentIncluded: true, content: 'identical\n' }), row.id);
});

test('content/hash tampering in persisted evidence fails closed over API', async () => {
  const row = seedStore.database
    .prepare('SELECT id, after_state, after_hash FROM file_change_evidence WHERE relative_path = ?')
    .get('src-new.js');
  const originalAfterStateJson = row.after_state;
  const originalAfterState = JSON.parse(originalAfterStateJson);

  // Tamper with the content while keeping byteLength matching the tampered
  // content, so we isolate the independent SHA-256 content verification.
  const tamperedContent = 'const evil = true;\n';
  const tamperedBytes = Buffer.byteLength(tamperedContent, 'utf8');
  const tamperedState = {
    ...originalAfterState,
    content: tamperedContent,
    size: tamperedBytes,
    byteLength: tamperedBytes
    // hash is deliberately left as the original persisted hash!
  };

  seedStore.database
    .prepare('UPDATE file_change_evidence SET after_state = ? WHERE id = ?')
    .run(JSON.stringify(tamperedState), row.id);

  const { status, body, text } = await request(`/api/project/changes?taskId=${TASK_ID}&path=src-new.js`);
  assert.equal(status, 200);
  const tampered = body.changes[0];

  assert.equal(tampered.integrity, 'malformed');
  assert.ok(tampered.integrityIssues.includes('after_content_hash_mismatch'));
  assert.equal(tampered.changeType, 'metadata_only');
  assert.equal(tampered.after.contentState, 'unavailable');
  assert.equal(tampered.after.content, undefined);
  assert.ok(!text.includes('const evil = true;'), 'tampered content must not be exposed over API');
  assert.equal(tampered.diff.kind, 'none');
  assert.equal(tampered.diff.reason, 'evidence_malformed');

  // Restore authentic after_state for subsequent tests.
  seedStore.database
    .prepare('UPDATE file_change_evidence SET after_state = ? WHERE id = ?')
    .run(originalAfterStateJson, row.id);
});

test('internal store failure produces a safe, detail-free API error', async () => {
  // Simulate an unreadable evidence table for the server's connection.
  seedStore.database.exec('DROP TABLE file_change_evidence');

  const { status, body, text } = await request(`/api/project/changes?taskId=${TASK_ID}`);
  assert.equal(status, 500);
  assert.equal(body.error, 'Could not retrieve file changes.');
  assertNoInternals(text);

  seedStore.database.exec(`
    CREATE TABLE file_change_evidence (
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
    )
  `);
});

test('no absolute host paths appear in any successful response', async () => {
  const { text } = await request(`/api/project/changes?taskId=${TASK_ID}&limit=200`);
  assertNoInternals(text);
});

test('read-only surface: no mutation routes exist under /api/project', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await fetch(`http://127.0.0.1:${port}/api/project/changes`, { method });
    assert.notEqual(response.status, 200, `${method} must not be served`);
    await response.text();
  }
});
