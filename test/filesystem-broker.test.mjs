import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { beforeEach, afterEach } from 'node:test';

import {
  createFilesystemBroker,
  clampBound,
  DEFAULT_MAX_FILE_SIZE,
  HARD_MAX_FILE_SIZE,
  DEFAULT_MAX_ENTRIES,
  HARD_MAX_ENTRIES
} from '../src/tools/filesystem-broker.mjs';

let testDir;
let outsideDir;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'fs-broker-test-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'fs-broker-outside-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

test('1. normal project-relative path resolves safely', async () => {
  const broker = createFilesystemBroker({ projectRoot: testDir });

  const r1 = broker.resolvePath('src/app.mjs');
  assert.equal(r1.relativePath, 'src/app.mjs');
  assert.equal(r1.absolutePath, join(testDir, 'src', 'app.mjs'));

  const r2 = broker.resolvePath('./src/app.mjs');
  assert.equal(r2.relativePath, 'src/app.mjs');
  assert.equal(r2.absolutePath, join(testDir, 'src', 'app.mjs'));

  const r3 = broker.resolvePath('README.md');
  assert.equal(r3.relativePath, 'README.md');
  assert.equal(r3.absolutePath, join(testDir, 'README.md'));
});

test('2. absolute path rejection where appropriate', async () => {
  const brokerDefault = createFilesystemBroker({
    projectRoot: testDir,
    allowAbsolute: false
  });

  // Rejects absolute path outside project root
  assert.throws(
    () => brokerDefault.resolvePath('/etc/passwd'),
    /Absolute paths are not permitted/
  );

  // Rejects absolute path even within project root when allowAbsolute is false
  assert.throws(
    () => brokerDefault.resolvePath(join(testDir, 'src', 'app.mjs')),
    /Absolute paths are not permitted/
  );

  // With allowAbsolute: true, allows absolute path inside project root
  const brokerAllowAbs = createFilesystemBroker({
    projectRoot: testDir,
    allowAbsolute: true
  });

  const inside = brokerAllowAbs.resolvePath(join(testDir, 'src', 'app.mjs'));
  assert.equal(inside.relativePath, 'src/app.mjs');

  // But still rejects absolute path outside project root
  assert.throws(
    () => brokerAllowAbs.resolvePath('/etc/passwd'),
    /Path escapes approved project root/
  );
  assert.throws(
    () => brokerAllowAbs.resolvePath(join(outsideDir, 'secret.txt')),
    /Path escapes approved project root/
  );
});

test('3. ../ traversal rejection', async () => {
  const broker = createFilesystemBroker({ projectRoot: testDir });

  assert.throws(
    () => broker.resolvePath('../outside.txt'),
    /Path traversal detected/
  );
  assert.throws(
    () => broker.resolvePath('..'),
    /Path traversal detected/
  );
  assert.throws(
    () => broker.resolvePath('../'),
    /Path traversal detected/
  );
});

test('4. nested traversal rejection', async () => {
  const broker = createFilesystemBroker({ projectRoot: testDir });

  assert.throws(
    () => broker.resolvePath('src/../../outside.txt'),
    /Path traversal detected/
  );
  assert.throws(
    () => broker.resolvePath('a/b/c/../../../../secret.txt'),
    /Path traversal detected/
  );
});

test('5. normalized-path escape rejection', async () => {
  const broker = createFilesystemBroker({ projectRoot: testDir });

  assert.throws(
    () => broker.resolvePath('./foo/bar/../../../escaped'),
    /Path traversal detected/
  );
  assert.throws(
    () => broker.resolvePath('foo/./../..'),
    /Path traversal detected/
  );
  assert.throws(
    () => broker.resolvePath('foo/bar/..//../..'),
    /Path traversal detected/
  );
});

test('6. project-root enforcement', async () => {
  // Empty or invalid project root is rejected
  assert.throws(
    () => createFilesystemBroker({ projectRoot: '' }),
    /projectRoot must be a non-empty string/
  );
  assert.throws(
    () => createFilesystemBroker({ projectRoot: null }),
    /projectRoot must be a non-empty string/
  );

  const broker = createFilesystemBroker({ projectRoot: testDir });
  assert.equal(broker.projectRoot, testDir);

  // Root itself allowed when allowRoot is set
  const rootRes = broker.resolvePath('.', { allowRoot: true });
  assert.equal(rootRes.absolutePath, testDir);
  assert.equal(rootRes.relativePath, '.');

  // Sibling prefix attack: a directory sharing a prefix with root must be blocked
  // e.g. /tmp/test-proj-evil when root is /tmp/test-proj
  const siblingPath = `../${join(testDir).split('/').pop()}-evil/file.txt`;
  assert.throws(
    () => broker.resolvePath(siblingPath),
    /Path traversal detected/
  );
});

test('7. safe file listing', async () => {
  // Create sample directory structure
  await mkdir(join(testDir, 'src'), { recursive: true });
  await mkdir(join(testDir, '.git'), { recursive: true });
  await mkdir(join(testDir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(testDir, '.continuity-agent'), { recursive: true });

  await writeFile(join(testDir, 'README.md'), '# Test');
  await writeFile(join(testDir, 'src', 'index.js'), 'console.log(1);');
  await writeFile(join(testDir, 'src', 'utils.js'), 'export default {};');
  await writeFile(join(testDir, '.env'), 'SECRET=bad');
  await writeFile(join(testDir, '.git', 'HEAD'), 'ref: refs/heads/main');
  await writeFile(join(testDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};');
  await writeFile(join(testDir, '.continuity-agent', 'tasks.json'), '[]');

  const broker = createFilesystemBroker({ projectRoot: testDir });
  const result = await broker.listFiles('.');

  assert.ok(Array.isArray(result.files));
  assert.deepEqual(result.files, [
    'README.md',
    'src/index.js',
    'src/utils.js'
  ]);

  // Ensure sensitive files/dirs are not listed
  assert.ok(!result.files.includes('.env'));
  assert.ok(!result.files.some(f => f.startsWith('.git')));
  assert.ok(!result.files.some(f => f.startsWith('node_modules')));
  assert.ok(!result.files.some(f => f.startsWith('.continuity-agent')));

  // Listing non-existent directory throws
  await assert.rejects(
    () => broker.listFiles('missing-dir'),
    /Directory not found/
  );

  // Listing a sensitive directory explicitly is blocked
  await assert.rejects(
    () => broker.listFiles('.git'),
    /Access to sensitive file or directory is blocked/
  );

  // Respects entry limit
  const limited = await broker.listFiles('.', { limit: 2 });
  assert.equal(limited.files.length, 2);
});

test('8. safe file read', async () => {
  await writeFile(join(testDir, 'hello.txt'), 'Hello, Continuity Agent!');
  const broker = createFilesystemBroker({ projectRoot: testDir });

  const res = await broker.readFile('hello.txt');
  assert.equal(res.path, 'hello.txt');
  assert.equal(res.content, 'Hello, Continuity Agent!');
  assert.equal(res.size, 24);

  // Reading missing file throws
  await assert.rejects(
    () => broker.readFile('missing.txt'),
    /File not found/
  );

  // Reading directory as file throws
  await assert.rejects(
    () => broker.readFile('.'),
    /Target is not a regular file/
  );
});

test('9. oversized file rejection', async () => {
  const broker = createFilesystemBroker({
    projectRoot: testDir,
    maxFileSize: 50
  });

  await writeFile(join(testDir, 'large.txt'), 'A'.repeat(100));

  // readFile rejects oversized file
  await assert.rejects(
    () => broker.readFile('large.txt'),
    /exceeds maximum allowed limit of 50 bytes/
  );

  // writeFile rejects oversized content
  await assert.rejects(
    () => broker.writeFile('new-large.txt', 'B'.repeat(60), {
      authorizeWrite: () => true
    }),
    /exceeds maximum allowed limit of 50 bytes/
  );
});

test('10. sensitive-file protection', async () => {
  await mkdir(join(testDir, 'keys'), { recursive: true });
  await mkdir(join(testDir, '.git'), { recursive: true });
  await mkdir(join(testDir, '.continuity-agent'), { recursive: true });

  await writeFile(join(testDir, '.env'), 'KEY=123');
  await writeFile(join(testDir, '.env.local'), 'KEY=local');
  await writeFile(join(testDir, 'keys', 'server.key'), 'PRIVATE');
  await writeFile(join(testDir, 'keys', 'cert.pem'), 'CERT');
  await writeFile(join(testDir, 'keys', 'id_rsa'), 'RSA');
  await writeFile(join(testDir, '.git', 'config'), '[core]');
  await writeFile(join(testDir, '.continuity-agent', 'store.json'), '{}');

  const broker = createFilesystemBroker({ projectRoot: testDir });

  // Read blocked on all sensitive files
  await assert.rejects(
    () => broker.readFile('.env'),
    /Access to sensitive file or directory is blocked: '\.env'/
  );
  await assert.rejects(
    () => broker.readFile('.env.local'),
    /Access to sensitive file or directory is blocked: '\.env\.local'/
  );
  await assert.rejects(
    () => broker.readFile('keys/server.key'),
    /Access to sensitive file or directory is blocked: 'keys\/server\.key'/
  );
  await assert.rejects(
    () => broker.readFile('keys/cert.pem'),
    /Access to sensitive file or directory is blocked: 'keys\/cert\.pem'/
  );
  await assert.rejects(
    () => broker.readFile('keys/id_rsa'),
    /Access to sensitive file or directory is blocked: 'keys\/id_rsa'/
  );
  await assert.rejects(
    () => broker.readFile('.git/config'),
    /Access to sensitive file or directory is blocked: '\.git\/config'/
  );
  await assert.rejects(
    () => broker.readFile('.continuity-agent/store.json'),
    /Access to sensitive file or directory is blocked: '\.continuity-agent\/store\.json'/
  );

  // Writing to sensitive file is blocked before authorization
  let authCalled = false;
  await assert.rejects(
    () => broker.writeFile('.env', 'MALICIOUS=true', {
      authorizeWrite: () => {
        authCalled = true;
        return true;
      }
    }),
    /Access to sensitive file or directory is blocked: '\.env'/
  );
  assert.equal(authCalled, false, 'Authorization hook must NOT be called for sensitive files');
});

test('11. write/patch authorization hook behavior', async () => {
  // Fail closed when no hook is configured
  const unauthBroker = createFilesystemBroker({ projectRoot: testDir });
  await assert.rejects(
    () => unauthBroker.writeFile('file.txt', 'hello'),
    /no explicit authorization hook configured for 'write'/
  );

  await writeFile(join(testDir, 'file.txt'), 'hello a world');
  await assert.rejects(
    () => unauthBroker.patchFile('file.txt', { targetContent: 'a', replacementContent: 'b' }),
    /no explicit authorization hook configured for 'patch'/
  );

  // Hook rejection
  const denyingBroker = createFilesystemBroker({
    projectRoot: testDir,
    authorizeWrite: () => false
  });
  await assert.rejects(
    () => denyingBroker.writeFile('file.txt', 'hello'),
    /File modification denied for 'file\.txt'/
  );

  // Hook rejection with specific reason object
  const reasonBroker = createFilesystemBroker({
    projectRoot: testDir,
    authorizeWrite: () => ({ approved: false, reason: 'Writes locked during maintenance' })
  });
  await assert.rejects(
    () => reasonBroker.writeFile('file.txt', 'hello'),
    /Writes locked during maintenance/
  );

  // Hook approval allows write
  const auditLog = [];
  const approvingBroker = createFilesystemBroker({
    projectRoot: testDir,
    authorizeWrite: async details => {
      auditLog.push(details);
      return true;
    }
  });

  const writeResult = await approvingBroker.writeFile('docs/guide.txt', 'Line 1\nLine 2');
  assert.equal(writeResult.changed, true);
  assert.equal(writeResult.newBytes, 13);
  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].operation, 'write');
  assert.equal(auditLog[0].path, 'docs/guide.txt');

  // Verify file was written
  const readResult = await approvingBroker.readFile('docs/guide.txt');
  assert.equal(readResult.content, 'Line 1\nLine 2');

  // Patching with authorization hook
  const patchResult = await approvingBroker.patchFile('docs/guide.txt', {
    targetContent: 'Line 2',
    replacementContent: 'Line 2 patched'
  });
  assert.equal(patchResult.changed, true);
  assert.equal(auditLog.length, 2);
  assert.equal(auditLog[1].operation, 'patch');

  // Verify patched content
  const readPatched = await approvingBroker.readFile('docs/guide.txt');
  assert.equal(readPatched.content, 'Line 1\nLine 2 patched');

  // Patch with missing targetContent fails closed
  await assert.rejects(
    () => approvingBroker.patchFile('docs/guide.txt', {
      targetContent: 'NonExistent',
      replacementContent: 'Replacement'
    }),
    /Target content to patch was not found/
  );

  // Functional patch
  await approvingBroker.patchFile('docs/guide.txt', content => content.replace('Line 1', 'Header'));
  const readFuncPatched = await approvingBroker.readFile('docs/guide.txt');
  assert.equal(readFuncPatched.content, 'Header\nLine 2 patched');
});

test('12. malformed/invalid path handling', async () => {
  const broker = createFilesystemBroker({ projectRoot: testDir });

  // Non-string inputs
  assert.throws(() => broker.resolvePath(null), /path must be a string/);
  assert.throws(() => broker.resolvePath(undefined), /path must be a string/);
  assert.throws(() => broker.resolvePath(123), /path must be a string/);
  assert.throws(() => broker.resolvePath({}), /path must be a string/);
  assert.throws(() => broker.resolvePath([]), /path must be a string/);

  // Empty string
  assert.throws(() => broker.resolvePath(''), /path cannot be empty/);
  assert.throws(() => broker.resolvePath('   '), /path cannot be empty/);

  // Null byte injection
  assert.throws(() => broker.resolvePath('src/file\0.txt'), /null bytes are not permitted/);
  assert.throws(() => broker.resolvePath('foo\0/../bar'), /null bytes are not permitted/);
});

test('13. no access outside project root (including symlinks)', async () => {
  // Create an outside secret file
  await writeFile(join(outsideDir, 'outside_secret.txt'), 'CONFIDENTIAL_DATA');

  // Create a symlink inside the project pointing to the outside secret file
  await symlink(
    join(outsideDir, 'outside_secret.txt'),
    join(testDir, 'evil_symlink.txt')
  );

  const broker = createFilesystemBroker({ projectRoot: testDir });

  // Attempting to resolve the escaping symlink throws
  assert.throws(
    () => broker.resolvePath('evil_symlink.txt'),
    /Symlink traversal detected: path resolves outside approved project root/
  );

  // Attempting to read through the escaping symlink fails closed
  await assert.rejects(
    () => broker.readFile('evil_symlink.txt'),
    /Symlink traversal detected/
  );

  // Internal symlink pointing inside project root works safely
  await writeFile(join(testDir, 'internal.txt'), 'Internal data');
  await symlink(
    join(testDir, 'internal.txt'),
    join(testDir, 'safe_symlink.txt')
  );

  const readInternal = await broker.readFile('safe_symlink.txt');
  assert.equal(readInternal.content, 'Internal data');
});

test('14. clampBound enforces limits safely for invalid, negative, non-integer, and oversized inputs', () => {
  // Invalid / non-number inputs -> defaultValue
  assert.equal(clampBound(undefined, 10, 20), 10);
  assert.equal(clampBound(null, 10, 20), 10);
  assert.equal(clampBound('abc', 10, 20), 10);
  assert.equal(clampBound({}, 10, 20), 10);

  // Negative / less than minBound -> defaultValue
  assert.equal(clampBound(-5, 10, 20), 10);

  // Non-integer -> defaultValue
  assert.equal(clampBound(5.5, 10, 20), 10);

  // Oversized -> maxBound
  assert.equal(clampBound(100, 10, 20), 20);

  // Smaller valid value -> allowed
  assert.equal(clampBound(15, 10, 20), 15);
});

test('15. broker enforces hard maximum resource limits on maxFileSize, maxEntries, and listFiles limit', async () => {
  // Oversized maxFileSize clamped to HARD_MAX_FILE_SIZE
  const oversizedBroker = createFilesystemBroker({
    projectRoot: testDir,
    maxFileSize: 100 * 1024 * 1024, // 100 MB requested
    maxEntries: 99999 // 99k entries requested
  });
  assert.equal(oversizedBroker.maxFileSize, HARD_MAX_FILE_SIZE);
  assert.equal(oversizedBroker.maxEntries, HARD_MAX_ENTRIES);

  // Invalid/negative maxFileSize clamped to DEFAULT_MAX_FILE_SIZE
  const invalidBroker = createFilesystemBroker({
    projectRoot: testDir,
    maxFileSize: -10,
    maxEntries: 'invalid'
  });
  assert.equal(invalidBroker.maxFileSize, DEFAULT_MAX_FILE_SIZE);
  assert.equal(invalidBroker.maxEntries, DEFAULT_MAX_ENTRIES);

  // listFiles per-call limit cannot exceed HARD_MAX_ENTRIES
  for (let i = 0; i < 20; i += 1) {
    await writeFile(join(testDir, `file_${i}.txt`), `Content ${i}`);
  }

  const broker = createFilesystemBroker({ projectRoot: testDir, maxEntries: 10 });
  const resClamped = await broker.listFiles('.', { limit: 999999 });
  // Per-call limit clamped to HARD_MAX_ENTRIES (1000) or effectiveMaxEntries
  assert.ok(resClamped.files.length <= HARD_MAX_ENTRIES);

  const resSmall = await broker.listFiles('.', { limit: 5 });
  assert.equal(resSmall.files.length, 5);
});

test('16. listFiles permits safe internal symlinks and rejects external/sensitive symlinks', async () => {
  await writeFile(join(testDir, 'target.txt'), 'Target data');
  await writeFile(join(outsideDir, 'secret_outside.txt'), 'Outside data');
  await writeFile(join(testDir, '.env'), 'SECRET=123');

  // Safe internal symlink
  await symlink(join(testDir, 'target.txt'), join(testDir, 'internal_link.txt'));
  // External symlink
  await symlink(join(outsideDir, 'secret_outside.txt'), join(testDir, 'external_link.txt'));
  // Symlink pointing to a sensitive file
  await symlink(join(testDir, '.env'), join(testDir, 'env_link.txt'));

  const broker = createFilesystemBroker({ projectRoot: testDir });
  const result = await broker.listFiles('.');

  // Safe internal symlink is included
  assert.ok(result.files.includes('internal_link.txt'));
  // External symlink is rejected / excluded
  assert.ok(!result.files.includes('external_link.txt'));
  // Symlink to sensitive file is rejected / excluded
  assert.ok(!result.files.includes('env_link.txt'));
});

test('17. tool-broker integration respects policy layer for write/patch operations', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  // Config that denies write operations
  const denyWriteConfig = {
    allowWrites: false,
    allowedCommands: ['echo']
  };

  const denyBroker = createToolBroker(testDir, denyWriteConfig);

  // Read operations should work
  await writeFile(join(testDir, 'test.txt'), 'content');
  const readResult = await denyBroker.execute({
    name: 'read_file',
    arguments: { path: 'test.txt' }
  });
  assert.equal(readResult.content, 'content');

  // Write operations should be denied by policy
  await assert.rejects(
    () => denyBroker.execute({
      name: 'write_file',
      arguments: { path: 'new.txt', content: 'data' }
    }),
    /File modifications are disabled by local policy/
  );

  // Patch operations should be denied by policy (patch_file uses same policy as write_file)
  await assert.rejects(
    () => denyBroker.execute({
      name: 'patch_file',
      arguments: {
        path: 'test.txt',
        targetContent: 'content',
        replacementContent: 'patched'
      }
    }),
    /File modifications are disabled by local policy/
  );

  // Config that allows write operations (requires_approval is NOT treated as allowed)
  const requireApprovalConfig = {
    allowWrites: true,
    allowedCommands: ['echo']
  };

  const requireApprovalBroker = createToolBroker(testDir, requireApprovalConfig);

  // Write operations should be denied when policy returns requires_approval
  await assert.rejects(
    () => requireApprovalBroker.execute({
      name: 'write_file',
      arguments: { path: 'allowed.txt', content: 'allowed content' }
    }),
    /File changes require an explicit, parameter-bound approval flow/
  );

  // Patch operations should be denied when policy returns requires_approval
  await assert.rejects(
    () => requireApprovalBroker.execute({
      name: 'patch_file',
      arguments: {
        path: 'test.txt',
        targetContent: 'content',
        replacementContent: 'patched content'
      }
    }),
    /File changes require an explicit, parameter-bound approval flow/
  );

  // Verify the file was NOT modified
  const verifyRead = await requireApprovalBroker.execute({
    name: 'read_file',
    arguments: { path: 'test.txt' }
  });
  assert.equal(verifyRead.content, 'content');
});

test('18. brokerOptions cannot override Tool Broker policy authorization hooks', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  // Config that denies write operations
  const denyWriteConfig = {
    allowWrites: false,
    allowedCommands: ['echo']
  };

  await writeFile(join(testDir, 'test.txt'), 'content');

  // Attempt to bypass policy by supplying authorizeWrite: () => true through brokerOptions
  const bypassBroker = createToolBroker(testDir, denyWriteConfig, {
    authorizeWrite: () => true, // This should NOT override the Tool Broker's policy hook
    authorizePatch: () => true  // This should NOT override the Tool Broker's policy hook
  });

  // Write should still be denied by Tool Broker policy despite brokerOptions bypass attempt
  await assert.rejects(
    () => bypassBroker.execute({
      name: 'write_file',
      arguments: { path: 'bypass.txt', content: 'malicious content' }
    }),
    /File modifications are disabled by local policy/
  );

  // Patch should still be denied by Tool Broker policy despite brokerOptions bypass attempt
  await assert.rejects(
    () => bypassBroker.execute({
      name: 'patch_file',
      arguments: {
        path: 'test.txt',
        targetContent: 'content',
        replacementContent: 'malicious patch'
      }
    }),
    /File modifications are disabled by local policy/
  );

  // Verify files remain unchanged
  const verifyFile = await bypassBroker.execute({
    name: 'read_file',
    arguments: { path: 'test.txt' }
  });
  assert.equal(verifyFile.content, 'content');

  // Test with allowWrites=true (returns requires_approval)
  const requireApprovalConfig = {
    allowWrites: true,
    allowedCommands: ['echo']
  };

  const approvalBypassBroker = createToolBroker(testDir, requireApprovalConfig, {
    authorizeWrite: () => true, // This should NOT override the Tool Broker's policy hook
    authorizePatch: () => true  // This should NOT override the Tool Broker's policy hook
  });

  // Write should still be denied because policy returns requires_approval, not allowed
  await assert.rejects(
    () => approvalBypassBroker.execute({
      name: 'write_file',
      arguments: { path: 'bypass2.txt', content: 'malicious content' }
    }),
    /File changes require an explicit, parameter-bound approval flow/
  );

  // Patch should still be denied because policy returns requires_approval, not allowed
  await assert.rejects(
    () => approvalBypassBroker.execute({
      name: 'patch_file',
      arguments: {
        path: 'test.txt',
        targetContent: 'content',
        replacementContent: 'malicious patch'
      }
    }),
    /File changes require an explicit, parameter-bound approval flow/
  );

  // Verify file remains unchanged
  const verifyFile2 = await approvalBypassBroker.execute({
    name: 'read_file',
    arguments: { path: 'test.txt' }
  });
  assert.equal(verifyFile2.content, 'content');

  // Verify that brokerOptions can still be used for legitimate non-security configuration
  const legitimateConfig = {
    allowWrites: false,
    allowedCommands: ['echo']
  };

  const legitimateBroker = createToolBroker(testDir, legitimateConfig, {
    maxFileSize: 100, // This should work - legitimate configuration
    maxEntries: 50    // This should work - legitimate configuration
  });

  // Verify the legitimate options were applied
  assert.equal(legitimateBroker.filesystemBroker.maxFileSize, 100);
  assert.equal(legitimateBroker.filesystemBroker.maxEntries, 50);
});
