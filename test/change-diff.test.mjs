import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChangeDiff,
  MAX_DIFF_LINES_PER_SIDE
} from '../src/tools/change-diff.mjs';
import { sha256Content } from '../src/tools/change-evidence.mjs';

const INCLUDED = (content, hash = sha256Content(content)) => ({
  present: true,
  readOutcome: 'ok',
  size: Buffer.byteLength(content, 'utf8'),
  byteLength: Buffer.byteLength(content, 'utf8'),
  hash,
  contentIncluded: true,
  content
});

function makeRecord(overrides = {}) {
  const defaultAfterContent = 'console.log("hi");\n';
  const defaultAfterHash = sha256Content(defaultAfterContent);
  return {
    id: 'ev-1',
    toolActionId: 'action-1',
    idempotencyKey: 'key-1',
    taskId: 'task-1',
    toolName: 'write_file',
    operation: 'write',
    relativePath: 'src/app.js',
    evidenceVersion: 1,
    beforeState: { present: false, readOutcome: 'not_found', contentIncluded: false },
    afterState: INCLUDED(defaultAfterContent, defaultAfterHash),
    beforeHash: null,
    afterHash: defaultAfterHash,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('created: missing before-state is distinguished from empty content', () => {
  const emptyHash = sha256Content('');
  const diff = buildChangeDiff(makeRecord({
    afterState: INCLUDED('', emptyHash),
    afterHash: emptyHash
  }));

  assert.equal(diff.changeType, 'created');
  assert.equal(diff.before.present, false);
  assert.equal(diff.before.contentState, 'absent');
  assert.equal(diff.after.contentState, 'included');
  assert.equal(diff.after.content, '');
  assert.equal(diff.after.byteLength, 0);
  assert.equal(diff.diff.kind, 'lines');
  assert.equal(diff.diff.lines.length, 0);
});

test('modified: deterministic structured line diff with line numbers', () => {
  const beforeContent = 'const a = 1;\nconst b = 2;\n';
  const afterContent = 'const a = 1;\nconst b = 3;\n';
  const beforeHash = sha256Content(beforeContent);
  const afterHash = sha256Content(afterContent);

  const diff = buildChangeDiff(makeRecord({
    beforeState: INCLUDED(beforeContent, beforeHash),
    beforeHash,
    afterState: INCLUDED(afterContent, afterHash),
    afterHash
  }));

  assert.equal(diff.changeType, 'modified');
  assert.equal(diff.diff.kind, 'lines');
  assert.deepEqual(diff.diff.lines, [
    { type: 'context', before: 1, after: 1, text: 'const a = 1;' },
    { type: 'del', before: 2, after: null, text: 'const b = 2;' },
    { type: 'add', before: null, after: 2, text: 'const b = 3;' }
  ]);
});

test('deleted: before content becomes del lines, after-state is explicitly absent', () => {
  const beforeContent = 'gone\n';
  const beforeHash = sha256Content(beforeContent);
  const diff = buildChangeDiff(makeRecord({
    beforeState: INCLUDED(beforeContent, beforeHash),
    beforeHash,
    afterState: { present: false, readOutcome: 'not_found', contentIncluded: false },
    afterHash: null
  }));

  assert.equal(diff.changeType, 'deleted');
  assert.equal(diff.after.present, false);
  assert.equal(diff.after.contentState, 'absent');
  assert.equal(diff.afterHash, null);
  assert.deepEqual(diff.diff.lines, [
    { type: 'del', before: 1, after: null, text: 'gone' }
  ]);
});

test('unchanged: equal hashes produce no fabricated diff lines', () => {
  const content = 'same\n';
  const hash = sha256Content(content);
  const diff = buildChangeDiff(makeRecord({
    beforeState: INCLUDED(content, hash),
    beforeHash: hash,
    afterState: INCLUDED(content, hash),
    afterHash: hash
  }));

  assert.equal(diff.changeType, 'unchanged');
  assert.deepEqual(diff.diff, { kind: 'none', reason: 'unchanged' });
});

test('hashes from the durable record are preserved in the response', () => {
  const content = 'console.log("hi");\n';
  const afterHash = sha256Content(content);
  const diff = buildChangeDiff(makeRecord({
    beforeHash: '1'.repeat(64),
    afterHash,
    afterState: INCLUDED(content, afterHash)
  }));

  assert.equal(diff.beforeHash, '1'.repeat(64));
  assert.equal(diff.afterHash, afterHash);
  assert.equal(diff.before.hash, null);
  assert.equal(diff.after.hash, afterHash);
});

test('content omitted under the evidence bound is explicit and never empty', () => {
  const afterContent = 'new\n';
  const afterHash = sha256Content(afterContent);
  const diff = buildChangeDiff(makeRecord({
    beforeState: {
      present: true,
      readOutcome: 'ok',
      size: 100_000,
      byteLength: 100_000,
      hash: '3'.repeat(64),
      contentIncluded: false
    },
    beforeHash: '3'.repeat(64),
    afterState: INCLUDED(afterContent, afterHash),
    afterHash
  }));

  assert.equal(diff.before.contentState, 'omitted_evidence_bound');
  assert.equal(diff.before.content, undefined);
  assert.equal(diff.before.hash, '3'.repeat(64));
  assert.equal(diff.changeType, 'modified');
  assert.equal(diff.diff.kind, 'none');
  assert.equal(diff.diff.reason, 'content_unavailable_before');
});

test('sensitive/blocked state exposes no content anywhere in the diff object', () => {
  const diff = buildChangeDiff(makeRecord({
    relativePath: '.env',
    toolName: 'patch_file',
    operation: 'patch',
    beforeState: { present: false, readOutcome: 'sensitive_blocked', contentIncluded: false },
    afterState: { present: false, readOutcome: 'sensitive_blocked', contentIncluded: false },
    beforeHash: null,
    afterHash: null
  }));

  assert.equal(diff.before.contentState, 'blocked_sensitive');
  assert.equal(diff.after.contentState, 'blocked_sensitive');
  assert.equal(diff.changeType, 'metadata_only');
  assert.equal(diff.diff.reason, 'hashes_unavailable');
  assert.ok(!JSON.stringify(diff).includes('SECRET'));
  assert.ok(!('content' in diff.before));
  assert.ok(!('content' in diff.after));
});

test('oversized/broker-blocked state exposes no content and no invented hash', () => {
  const afterContent = 'tiny\n';
  const afterHash = sha256Content(afterContent);
  const diff = buildChangeDiff(makeRecord({
    beforeState: { present: true, readOutcome: 'size_exceeded', contentIncluded: false },
    afterState: INCLUDED(afterContent, afterHash),
    afterHash
  }));

  assert.equal(diff.before.contentState, 'oversized_broker_limit');
  assert.equal(diff.before.present, true);
  assert.equal(diff.before.hash, null);
  assert.equal(diff.changeType, 'metadata_only');
  assert.equal(diff.diff.reason, 'hashes_unavailable');
});

test('state hash contradicting the persisted column hash fails closed', () => {
  const beforeContent = 'tampered?\n';
  const beforeHash = sha256Content(beforeContent);
  const afterContent = 'new\n';
  const afterHash = sha256Content(afterContent);

  const diff = buildChangeDiff(makeRecord({
    beforeState: INCLUDED(beforeContent, beforeHash),
    beforeHash: '7'.repeat(64), // Mismatch with beforeState.hash
    afterState: INCLUDED(afterContent, afterHash),
    afterHash
  }));

  assert.equal(diff.integrity, 'malformed');
  assert.ok(diff.integrityIssues.includes('hash_mismatch_before'));
  assert.equal(diff.changeType, 'metadata_only');
  assert.equal(diff.diff.reason, 'evidence_malformed');
  assert.equal(diff.before.content, undefined);
});

test('malformed persisted states fail safely without a fabricated diff', () => {
  const diff = buildChangeDiff(makeRecord({
    beforeState: null,
    afterState: { nonsense: true },
    beforeHash: null,
    afterHash: null
  }));

  assert.equal(diff.integrity, 'malformed');
  assert.ok(diff.integrityIssues.includes('after_present_invalid') || diff.integrityIssues.includes('after_state_unknown'));
  assert.equal(diff.changeType, 'metadata_only');
  assert.deepEqual(diff.diff, { kind: 'none', reason: 'evidence_malformed' });
});

test('content claiming to be included but inconsistent fails closed', () => {
  const missingContent = buildChangeDiff(makeRecord({
    afterState: {
      present: true, readOutcome: 'ok', size: 5, byteLength: 5,
      hash: '9'.repeat(64), contentIncluded: true
    },
    afterHash: '9'.repeat(64)
  }));
  assert.equal(missingContent.integrity, 'malformed');
  assert.equal(missingContent.after.contentState, 'unavailable');
  assert.equal(missingContent.after.content, undefined);

  const wrongLength = buildChangeDiff(makeRecord({
    afterState: { ...INCLUDED('abc'), byteLength: 999 },
    afterHash: sha256Content('abc')
  }));
  assert.equal(wrongLength.integrity, 'malformed');
  assert.ok(wrongLength.integrityIssues.includes('after_content_length_mismatch'));
  assert.equal(wrongLength.after.contentState, 'unavailable');
  assert.equal(wrongLength.after.content, undefined);
});

test('identical evidence produces byte-identical diff output (determinism)', () => {
  const beforeContent = 'one\ntwo\nthree\n';
  const afterContent = 'one\nTWO\nthree\nfour\n';
  const beforeHash = sha256Content(beforeContent);
  const afterHash = sha256Content(afterContent);

  const record = makeRecord({
    beforeState: INCLUDED(beforeContent, beforeHash),
    beforeHash,
    afterState: INCLUDED(afterContent, afterHash),
    afterHash
  });

  const first = JSON.stringify(buildChangeDiff(record));
  const second = JSON.stringify(buildChangeDiff(record));
  const third = JSON.stringify(buildChangeDiff({ ...record }));

  assert.equal(first, second);
  assert.equal(first, third);
});

test('line diff cap: pathological line counts degrade to explicit metadata', () => {
  const many = Array.from({ length: MAX_DIFF_LINES_PER_SIDE + 1 }, () => 'x').join('\n');
  const beforeContent = 'x\n';
  const beforeHash = sha256Content(beforeContent);
  const afterHash = sha256Content(many);

  const diff = buildChangeDiff(makeRecord({
    beforeState: INCLUDED(beforeContent, beforeHash),
    beforeHash,
    afterState: INCLUDED(many, afterHash),
    afterHash
  }));

  assert.equal(diff.diff.kind, 'none');
  assert.equal(diff.diff.reason, 'line_count_exceeds_diff_bound');
  assert.equal(diff.diff.afterLineCount, MAX_DIFF_LINES_PER_SIDE + 1);
});

test('records missing identity fields are rejected, not silently transformed', () => {
  assert.throws(() => buildChangeDiff(null), /required/);
  assert.throws(() => buildChangeDiff({ ...makeRecord({}), relativePath: '' }), /missing relativePath/);
  assert.throws(() => buildChangeDiff({ ...makeRecord({}), operation: 42 }), /missing operation/);
});

// ── Phase 4: Focused Content/Hash Integrity Regression Tests ─────────────────

test('content/hash mismatch on after-state fails closed with after_content_hash_mismatch', () => {
  // Persisted state and column hashes agree with each other, but the actual
  // content differs (tampered or corrupted content).
  const expectedHash = sha256Content('authentic content\n');
  const tamperedContent = 'tampered/injected content\n';

  const diff = buildChangeDiff(makeRecord({
    afterState: {
      present: true,
      readOutcome: 'ok',
      size: Buffer.byteLength(tamperedContent, 'utf8'),
      byteLength: Buffer.byteLength(tamperedContent, 'utf8'),
      hash: expectedHash,
      contentIncluded: true,
      content: tamperedContent
    },
    afterHash: expectedHash
  }));

  assert.equal(diff.integrity, 'malformed');
  assert.ok(diff.integrityIssues.includes('after_content_hash_mismatch'));
  assert.equal(diff.after.contentState, 'unavailable');
  assert.equal(diff.after.content, undefined);
  assert.equal(diff.changeType, 'metadata_only');
  assert.equal(diff.diff.kind, 'none');
  assert.equal(diff.diff.reason, 'evidence_malformed');
  assert.ok(!JSON.stringify(diff.diff).includes('tampered'));
});

test('content/hash mismatch on before-state fails closed with before_content_hash_mismatch', () => {
  const expectedHash = sha256Content('original before content\n');
  const tamperedContent = 'forged before content\n';
  const afterContent = 'valid after content\n';
  const afterHash = sha256Content(afterContent);

  const diff = buildChangeDiff(makeRecord({
    beforeState: {
      present: true,
      readOutcome: 'ok',
      size: Buffer.byteLength(tamperedContent, 'utf8'),
      byteLength: Buffer.byteLength(tamperedContent, 'utf8'),
      hash: expectedHash,
      contentIncluded: true,
      content: tamperedContent
    },
    beforeHash: expectedHash,
    afterState: INCLUDED(afterContent, afterHash),
    afterHash
  }));

  assert.equal(diff.integrity, 'malformed');
  assert.ok(diff.integrityIssues.includes('before_content_hash_mismatch'));
  assert.equal(diff.before.contentState, 'unavailable');
  assert.equal(diff.before.content, undefined);
  assert.equal(diff.changeType, 'metadata_only');
  assert.equal(diff.diff.kind, 'none');
  assert.equal(diff.diff.reason, 'evidence_malformed');
});

test('UTF-8 non-ASCII characters: SHA-256 and byteLength calculated over UTF-8 bytes', () => {
  // Multibyte UTF-8 characters:
  // 'é' (2 bytes), '✓' (3 bytes), '🚀' (4 bytes), 'ñ' (2 bytes)
  const utf8Content = 'héllo ✓ 🚀 ñ\n';
  const expectedBytes = Buffer.byteLength(utf8Content, 'utf8');
  assert.notEqual(expectedBytes, utf8Content.length, 'UTF-8 byte length must differ from JS char count');
  assert.equal(expectedBytes, 19);

  const utf8Hash = sha256Content(utf8Content);

  const diff = buildChangeDiff(makeRecord({
    afterState: INCLUDED(utf8Content, utf8Hash),
    afterHash: utf8Hash
  }));

  assert.equal(diff.integrity, 'ok');
  assert.equal(diff.integrityIssues.length, 0);
  assert.equal(diff.after.contentState, 'included');
  assert.equal(diff.after.content, utf8Content);
  assert.equal(diff.after.byteLength, 19);
  assert.equal(diff.after.hash, utf8Hash);
  assert.equal(diff.diff.kind, 'lines');
  assert.deepEqual(diff.diff.lines, [
    { type: 'add', before: null, after: 1, text: 'héllo ✓ 🚀 ñ' }
  ]);
});

test('byteLength mismatch fails closed with content_length_mismatch', () => {
  const content = 'clean content\n';
  const realBytes = Buffer.byteLength(content, 'utf8');
  const hash = sha256Content(content);

  const diff = buildChangeDiff(makeRecord({
    afterState: {
      present: true,
      readOutcome: 'ok',
      size: realBytes,
      byteLength: realBytes + 10, // False byteLength
      hash,
      contentIncluded: true,
      content
    },
    afterHash: hash
  }));

  assert.equal(diff.integrity, 'malformed');
  assert.ok(diff.integrityIssues.includes('after_content_length_mismatch'));
  assert.equal(diff.after.contentState, 'unavailable');
  assert.equal(diff.after.content, undefined);
  assert.equal(diff.changeType, 'metadata_only');
  assert.equal(diff.diff.kind, 'none');
  assert.equal(diff.diff.reason, 'evidence_malformed');
});

test('null or missing byteLength on included content fails closed', () => {
  const content = 'content without byteLength\n';
  const hash = sha256Content(content);

  const diff = buildChangeDiff(makeRecord({
    afterState: {
      present: true,
      readOutcome: 'ok',
      size: 30,
      byteLength: null,
      hash,
      contentIncluded: true,
      content
    },
    afterHash: hash
  }));

  assert.equal(diff.integrity, 'malformed');
  assert.ok(diff.integrityIssues.includes('after_content_length_mismatch'));
  assert.equal(diff.after.contentState, 'unavailable');
  assert.equal(diff.after.content, undefined);
});

test('malformed evidence: invalid contentIncluded flag is rejected', () => {
  const content = 'test\n';
  const hash = sha256Content(content);

  for (const invalidFlag of ['true', 1, null, {}, []]) {
    const diff = buildChangeDiff(makeRecord({
      afterState: {
        present: true,
        readOutcome: 'ok',
        size: 5,
        byteLength: 5,
        hash,
        contentIncluded: invalidFlag,
        content
      },
      afterHash: hash
    }));

    assert.equal(diff.integrity, 'malformed');
    assert.ok(diff.integrityIssues.includes('after_content_included_invalid'), `flag=${invalidFlag} must be rejected`);
    assert.equal(diff.after.contentState, 'unavailable');
    assert.equal(diff.after.content, undefined);
  }
});

test('malformed evidence: invalid hash format fails closed with hash_invalid', () => {
  for (const invalidHash of ['not-a-hash', '1234', 'Z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    const diff = buildChangeDiff(makeRecord({
      afterState: {
        present: true,
        readOutcome: 'ok',
        size: 5,
        byteLength: 5,
        hash: invalidHash,
        contentIncluded: true,
        content: 'hello'
      },
      afterHash: null
    }));

    assert.equal(diff.integrity, 'malformed');
    assert.ok(diff.integrityIssues.includes('after_hash_invalid'), `hash=${invalidHash} must fail`);
    assert.equal(diff.after.contentState, 'unavailable');
    assert.equal(diff.after.content, undefined);
  }
});

test('malformed evidence: non-string content fails closed with content_inconsistent', () => {
  const hash = sha256Content('12345');
  const diff = buildChangeDiff(makeRecord({
    afterState: {
      present: true,
      readOutcome: 'ok',
      size: 5,
      byteLength: 5,
      hash,
      contentIncluded: true,
      content: 12345 // Number instead of string
    },
    afterHash: hash
  }));

  assert.equal(diff.integrity, 'malformed');
  assert.ok(diff.integrityIssues.includes('after_content_inconsistent'));
  assert.equal(diff.after.contentState, 'unavailable');
  assert.equal(diff.after.content, undefined);
});

test('malformed evidence: invalid present flag fails closed with present_invalid', () => {
  for (const invalidPresent of ['yes', 1, null, undefined]) {
    const diff = buildChangeDiff(makeRecord({
      afterState: {
        present: invalidPresent,
        readOutcome: 'ok',
        size: 5,
        byteLength: 5,
        hash: 'a'.repeat(64),
        contentIncluded: true,
        content: 'hello'
      },
      afterHash: 'a'.repeat(64)
    }));

    assert.equal(diff.integrity, 'malformed');
    assert.ok(diff.integrityIssues.includes('after_present_invalid'), `present=${invalidPresent} must be rejected`);
    assert.equal(diff.after.contentState, 'unavailable');
    assert.equal(diff.after.content, undefined);
  }
});

test('unavailable evidence states never produce fake content or line diffs', () => {
  const states = [
    { readOutcome: 'not_found', expectedContentState: 'absent' },
    { readOutcome: 'not_a_regular_file', expectedContentState: 'not_a_regular_file' },
    { readOutcome: 'sensitive_blocked', expectedContentState: 'blocked_sensitive' },
    { readOutcome: 'size_exceeded', expectedContentState: 'oversized_broker_limit' },
    { readOutcome: 'unreadable', expectedContentState: 'unreadable' }
  ];

  for (const { readOutcome, expectedContentState } of states) {
    const diff = buildChangeDiff(makeRecord({
      beforeState: { present: readOutcome === 'size_exceeded', readOutcome, contentIncluded: false },
      beforeHash: null,
      afterState: { present: false, readOutcome: 'not_found', contentIncluded: false },
      afterHash: null
    }));

    assert.equal(diff.before.contentState, expectedContentState);
    assert.equal(diff.before.content, undefined);
    assert.notEqual(diff.diff.kind, 'lines');
    assert.ok(!('lines' in diff.diff));
  }
});

