import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { DEFAULT_MAX_ENTRIES } from '../src/tools/filesystem-broker.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const OUTSIDE_MARKER = 'TOP-SECRET-OUTSIDE-CONTENT';

let fixtureDir;
let outsideDir;
let canonicalFixtureDir;
let canonicalOutsideDir;
let serverProcess;
let port;

const readmeContent =
  '# Fixture Project\n\nHello from the fixture.\nhéllo ✓\n';

function floodFileName(index) {
  return `f${String(index).padStart(3, '0')}.txt`;
}

async function createFixture() {
  fixtureDir = await mkdtemp(join(tmpdir(), 'project-api-fixture-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'project-api-outside-'));
  canonicalFixtureDir = realpathSync(fixtureDir);
  canonicalOutsideDir = realpathSync(outsideDir);

  await mkdir(join(fixtureDir, 'src'), { recursive: true });
  await mkdir(join(fixtureDir, 'docs'), { recursive: true });
  await mkdir(join(fixtureDir, 'assets'), { recursive: true });
  await mkdir(join(fixtureDir, 'secrets'), { recursive: true });
  await mkdir(join(fixtureDir, '.git'), { recursive: true });
  await mkdir(join(fixtureDir, 'node_modules'), { recursive: true });
  await mkdir(join(fixtureDir, 'flood'), { recursive: true });

  await writeFile(join(fixtureDir, 'README.md'), readmeContent);
  await writeFile(join(fixtureDir, 'src', 'app.js'), 'console.log("app");\n');
  await writeFile(join(fixtureDir, 'docs', 'notes.md'), 'notes\n');
  await writeFile(join(fixtureDir, 'cert.pem'), '-----BEGIN CERTIFICATE-----\n');
  await writeFile(join(fixtureDir, '.env'), 'SECRET=1\n');
  await writeFile(join(fixtureDir, 'secrets', 'token.json'), '{"token":"t"}');
  await writeFile(join(fixtureDir, '.git', 'config'), '[core]\n');
  await writeFile(join(fixtureDir, 'empty.txt'), '');

  const binaryBytes = Buffer.alloc(2048);
  for (let i = 0; i < binaryBytes.length; i += 1) {
    binaryBytes[i] = i % 2 === 0 ? 0x00 : 0x01;
  }
  await writeFile(join(fixtureDir, 'assets', 'logo.bin'), binaryBytes);

  await writeFile(join(fixtureDir, 'large-text.txt'), 'A'.repeat(300 * 1024));
  await writeFile(join(fixtureDir, 'ok-large.txt'), 'B'.repeat(100 * 1024));

  for (let i = 0; i < 200; i += 1) {
    await writeFile(
      join(fixtureDir, 'flood', floodFileName(i)),
      `file ${i}\n`
    );
  }

  await writeFile(join(outsideDir, 'leak.txt'), `${OUTSIDE_MARKER}\n`);
  await symlink(
    join(outsideDir, 'leak.txt'),
    join(fixtureDir, 'link-out.txt')
  );
  await symlink('./README.md', join(fixtureDir, 'link-in.md'));
}

function startServer() {
  return new Promise((resolvePromise, rejectPromise) => {
    // The server logs its configured port value, so an explicit random port
    // is used instead of PORT=0; readiness is confirmed by polling.
    port = 30_000 + Math.floor(Math.random() * 20_000);

    serverProcess = spawn(
      process.execPath,
      [join(repoRoot, 'src', 'server.mjs')],
      {
        cwd: repoRoot,
        env: { ...process.env, PROJECT_ROOT: fixtureDir, PORT: String(port) }
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
          `Server exited early (code ${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    });

    const poll = async attemptsLeft => {
      if (attemptsLeft <= 0) {
        rejectPromise(
          new Error(
            `Server did not become ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
        return;
      }

      try {
        const probe = await fetch(`http://127.0.0.1:${port}/api/models`);
        if (probe.ok) {
          resolvePromise();
          return;
        }
      } catch {
        // Server not accepting connections yet; keep polling.
      }

      setTimeout(() => poll(attemptsLeft - 1), 100);
    };

    poll(150);
  });
}

before(async () => {
  await createFixture();
  await startServer();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => {});
  }

  await rm(fixtureDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

function assertNoHostPathLeak(text) {
  for (const secret of [
    fixtureDir,
    canonicalFixtureDir,
    outsideDir,
    canonicalOutsideDir,
    OUTSIDE_MARKER
  ]) {
    assert.ok(
      !text.includes(secret),
      `response leaked host path or outside content: ${secret}`
    );
  }
}

async function request(target) {
  const response = await fetch(`http://127.0.0.1:${port}${target}`);
  const text = await response.text();

  assertNoHostPathLeak(text);

  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  return { status: response.status, text, body };
}

test('valid project listing returns bounded relative entries', async () => {
  const { status, body } = await request('/api/project/files?path=.&limit=1000');

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.path, '.');
  assert.ok(Array.isArray(body.files));
  assert.equal(body.truncated, undefined);
  assert.equal(body.limit, undefined);

  for (const expected of [
    'README.md',
    'src/app.js',
    'docs/notes.md',
    'assets/logo.bin',
    'flood/f000.txt',
    'link-in.md'
  ]) {
    assert.ok(body.files.includes(expected), `expected ${expected} in listing`);
  }

  for (const forbidden of [
    '.env',
    'secrets/token.json',
    '.git/config',
    'link-out.txt'
  ]) {
    assert.ok(
      !body.files.includes(forbidden),
      `${forbidden} must not be listed`
    );
  }

  for (const entry of body.files) {
    assert.ok(!entry.startsWith('/'), `entry must be relative: ${entry}`);
    assert.ok(!entry.includes('..'), `entry must not traverse: ${entry}`);
  }
});

test('listing respects an explicit limit and the default entry bound', async () => {
  // The broker owns entry bounds: the response reports only authoritative
  // data (no inferred truncation flag), so bounds are observed via counts.
  const limited = await request('/api/project/files?path=flood&limit=5');

  assert.equal(limited.status, 200);
  assert.equal(limited.body.ok, true);
  assert.equal(limited.body.files.length, 5);
  assert.ok(limited.body.files.every(entry => entry.startsWith('flood/')));
  assert.equal(limited.body.truncated, undefined);

  const defaulted = await request('/api/project/files?path=flood');

  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.body.files.length, DEFAULT_MAX_ENTRIES);
  assert.equal(defaulted.body.truncated, undefined);
});

test('valid file read returns utf-8 text with size', async () => {
  const { status, body } = await request('/api/project/file?path=README.md');

  assert.equal(status, 200);
  assert.equal(body.path, 'README.md');
  assert.equal(body.binary, false);
  assert.equal(body.encoding, 'utf-8');
  assert.equal(body.content, readmeContent);
  assert.equal(body.size, Buffer.byteLength(readmeContent, 'utf8'));

  const nested = await request('/api/project/file?path=src/app.js');

  assert.equal(nested.status, 200);
  assert.equal(nested.body.content, 'console.log("app");\n');

  const empty = await request('/api/project/file?path=empty.txt');

  assert.equal(empty.status, 200);
  assert.equal(empty.body.binary, false);
  assert.equal(empty.body.content, '');
});

test('empty path handling differs per endpoint', async () => {
  const fileEmpty = await request('/api/project/file?path=');

  assert.equal(fileEmpty.status, 400);
  assert.match(fileEmpty.body.error, /cannot be empty/);

  const listingEmpty = await request('/api/project/files?path=');

  assert.equal(listingEmpty.status, 200);
  assert.equal(listingEmpty.body.ok, true);
  assert.equal(listingEmpty.body.path, '.');
  assert.equal(listingEmpty.body.files.length, DEFAULT_MAX_ENTRIES);

  const listingNoParam = await request('/api/project/files');

  assert.equal(listingNoParam.status, 200);
  assert.equal(listingNoParam.body.path, '.');
  assert.equal(listingNoParam.body.files.length, DEFAULT_MAX_ENTRIES);
});

test('nonexistent paths return 404 without leaking details', async () => {
  const file = await request('/api/project/file?path=does/not-exist.txt');

  assert.equal(file.status, 404);
  assert.match(file.body.error, /File not found/);

  const listing = await request('/api/project/files?path=does-not-exist-dir');

  assert.equal(listing.status, 404);
  assert.match(listing.body.error, /Directory not found/);
});

test('raw and single-encoded traversal are rejected', async () => {
  const raw = await request(
    `/api/project/file?path=${encodeURIComponent('../outside-leak.txt')}`
  );

  assert.equal(raw.status, 400);
  assert.match(raw.body.error, /[Tt]raversal/);

  const encoded = await request('/api/project/file?path=%2e%2e%2fleak.txt');

  assert.equal(encoded.status, 400);
  assert.match(encoded.body.error, /[Tt]raversal/);

  const listing = await request('/api/project/files?path=..%2F');

  assert.equal(listing.status, 400);
  assert.match(listing.body.error, /[Tt]raversal/);
});

test('double-encoded traversal does not escape the project root', async () => {
  const { status, body } = await request(
    '/api/project/file?path=%252e%252e%252fleak.txt'
  );

  // The double-encoded value resolves to a literal file name inside the
  // project root: it must never escape, and the outside content must not
  // surface (already asserted for every response by assertNoHostPathLeak).
  assert.notEqual(status, 200);
  assert.notEqual(body?.content, OUTSIDE_MARKER);
});

test('absolute paths are rejected, even inside the project root', async () => {
  const outside = await request('/api/project/file?path=%2Fetc%2Fpasswd');

  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /Absolute paths are not permitted/);

  const insideRoot = await request(
    `/api/project/file?path=${encodeURIComponent(
      join(fixtureDir, 'README.md')
    )}`
  );

  assert.equal(insideRoot.status, 400);
  assert.match(insideRoot.body.error, /Absolute paths are not permitted/);
  assert.ok(!insideRoot.text.includes('fixture'));

  const listing = await request('/api/project/files?path=%2F');

  assert.equal(listing.status, 400);
});

test('null bytes are rejected', async () => {
  const file = await request('/api/project/file?path=README.md%00');

  assert.equal(file.status, 400);
  assert.match(file.body.error, /null bytes/);

  const listing = await request('/api/project/files?path=src%00');

  assert.equal(listing.status, 400);
  assert.match(listing.body.error, /null bytes/);
});

test('sensitive directories are rejected for reads and listings', async () => {
  for (const path of ['.git', '.git/config', 'node_modules']) {
    const result = await request(
      `/api/project/file?path=${encodeURIComponent(path)}`
    );

    assert.equal(result.status, 400, `${path} must be blocked`);
    assert.match(result.body.error, /sensitive file or directory is blocked/);
  }

  const listing = await request('/api/project/files?path=.git');

  assert.equal(listing.status, 400);
  assert.match(listing.body.error, /sensitive file or directory is blocked/);
});

test('sensitive files are rejected for reads', async () => {
  for (const path of ['.env', 'secrets/token.json', 'cert.pem']) {
    const result = await request(
      `/api/project/file?path=${encodeURIComponent(path)}`
    );

    assert.equal(result.status, 400, `${path} must be blocked`);
    assert.match(result.body.error, /sensitive file or directory is blocked/);
    assert.ok(!result.text.includes('SECRET'));
    assert.ok(!result.text.includes('"token"'));
  }
});

test('external symlinks are rejected and excluded from listings', async () => {
  const file = await request('/api/project/file?path=link-out.txt');

  assert.equal(file.status, 400);
  assert.match(file.body.error, /Symlink traversal detected/);

  const listing = await request('/api/project/files?path=.&limit=1000');

  assert.equal(listing.status, 200);
  assert.ok(!listing.body.files.includes('link-out.txt'));
});

test('internal symlinks stay readable', async () => {
  const { status, body } = await request('/api/project/file?path=link-in.md');

  assert.equal(status, 200);
  assert.equal(body.binary, false);
  assert.equal(body.content, readmeContent);
});

test('file size bound is enforced by the broker default', async () => {
  const tooLarge = await request('/api/project/file?path=large-text.txt');

  assert.equal(tooLarge.status, 400);
  assert.match(tooLarge.body.error, /exceeds maximum allowed limit/);

  const withinBound = await request('/api/project/file?path=ok-large.txt');

  assert.equal(withinBound.status, 200);
  assert.equal(withinBound.body.binary, false);
});

test('binary files are reported as metadata without content', async () => {
  const { status, body } = await request('/api/project/file?path=assets/logo.bin');

  assert.equal(status, 200);
  assert.equal(body.path, 'assets/logo.bin');
  assert.equal(body.binary, true);
  assert.equal(body.contentType, 'application/octet-stream');
  assert.equal(body.content, undefined);
  assert.ok(!('content' in body));
  assert.equal(body.size, 2048);
});

test('reading a directory and listing a file both fail cleanly', async () => {
  const readFileDir = await request('/api/project/file?path=src');

  assert.equal(readFileDir.status, 400);
  assert.match(readFileDir.body.error, /Target is not a regular file/);

  const listFile = await request('/api/project/files?path=README.md');

  assert.equal(listFile.status, 400);
  assert.match(listFile.body.error, /Target is not a directory/);
});

test('host paths are never disclosed across the error battery', async () => {
  const battery = [
    '/api/project/file?path=..%2F..%2Fetc%2Fpasswd',
    '/api/project/file?path=%00',
    '/api/project/file?path=.env',
    '/api/project/file?path=%2Fetc%2Fpasswd',
    '/api/project/files?path=..%2F..%2F',
    '/api/project/files?path=.git',
    '/api/project/file?path=link-out.txt',
    '/api/project/file?path=large-text.txt'
  ];

  for (const target of battery) {
    const { text } = await request(target);
    assertNoHostPathLeak(text);
  }
});
