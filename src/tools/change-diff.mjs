// Pure transformation layer: durable file_change_evidence records →
// deterministic, API-safe diff objects.
//
// Responsibilities are strictly separated:
// - store.mjs persists/retrieves evidence
// - this module transforms evidence into diff representations
// - server.mjs performs validation, retrieval, and response shaping
//
// This module NEVER accesses the filesystem or SQLite. The durable evidence is
// the sole source of truth: identical evidence always produces an identical
// diff, and unavailable content is never silently turned into an empty string.

import { sha256Content } from './change-evidence.mjs';

export const CHANGE_DIFF_SUPPORTED_STATES = Object.freeze([
  'included',
  'absent',
  'not_a_regular_file',
  'omitted_evidence_bound',
  'oversized_broker_limit',
  'blocked_sensitive',
  'unreadable',
  'unavailable'
]);

// Line-diff bounds: content-bearing states are already ≤ 64 KB (evidence
// bound), but pathological line counts (e.g. thousands of blank lines) are
// capped so a single record cannot produce an unbounded diff computation.
export const MAX_DIFF_LINES_PER_SIDE = 2000;
const MAX_LCS_CELLS = 1_000_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function toFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toLines(content) {
  if (content === '') return [];
  const lines = String(content).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Maps one Step 3A captured state (parsed JSON) to an API-safe side object.
// Integrity issues are appended to the shared record issue list so the record
// can fail closed as a whole. Content is emitted ONLY for verified 'included'
// states — corruption, mismatch, or unknown shapes never leak data.
function mapCapturedState(state, columnHash, side, issues) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    issues.push(`${side}_state_unparsable`);
    return { present: false, contentState: 'unavailable', readOutcome: null, size: null, byteLength: null, hash: null };
  }

  if (typeof state.present !== 'boolean') {
    issues.push(`${side}_present_invalid`);
    return { present: false, contentState: 'unavailable', readOutcome: null, size: null, byteLength: null, hash: null };
  }

  const readOutcome = typeof state.readOutcome === 'string' ? state.readOutcome : null;
  const size = toFiniteNumber(state.size);
  const byteLength = toFiniteNumber(state.byteLength);

  let hash = null;
  if ('hash' in state && state.hash !== null && state.hash !== undefined) {
    if (typeof state.hash === 'string' && SHA256_PATTERN.test(state.hash)) {
      hash = state.hash.toLowerCase();
    } else {
      issues.push(`${side}_hash_invalid`);
    }
  }

  // Cross-check the state hash against the denormalized column hash: a
  // mismatch means the persisted record is internally inconsistent, so no
  // content from this side can be trusted.
  if (
    hash &&
    typeof columnHash === 'string' &&
    columnHash &&
    hash !== columnHash.toLowerCase()
  ) {
    issues.push(`hash_mismatch_${side}`);
    return { present: state.present === true, contentState: 'unavailable', readOutcome, size, byteLength, hash: null };
  }

  if (readOutcome === 'ok' && state.present === true) {
    if (typeof state.contentIncluded !== 'boolean') {
      issues.push(`${side}_content_included_invalid`);
      return { present: true, contentState: 'unavailable', readOutcome, size, byteLength, hash };
    }

    if (state.contentIncluded === true) {
      const content = typeof state.content === 'string' ? state.content : null;
      if (content === null || !hash) {
        issues.push(`${side}_content_inconsistent`);
        return { present: true, contentState: 'unavailable', readOutcome, size, byteLength, hash };
      }
      const actualBytes = Buffer.byteLength(content, 'utf8');
      if (byteLength === null || byteLength !== actualBytes) {
        issues.push(`${side}_content_length_mismatch`);
        return { present: true, contentState: 'unavailable', readOutcome, size, byteLength, hash };
      }

      // Independently calculate the SHA-256 hash over UTF-8 bytes and verify
      // against the persisted evidence hash. Persisted hash + stored content
      // != trusted content; content is trusted ONLY after verification.
      const computedHash = sha256Content(content);
      if (computedHash.toLowerCase() !== hash) {
        issues.push(`${side}_content_hash_mismatch`);
        return { present: true, contentState: 'unavailable', readOutcome, size, byteLength, hash };
      }

      return {
        present: true,
        contentState: 'included',
        readOutcome,
        size: size ?? actualBytes,
        byteLength: actualBytes,
        hash,
        content
      };
    }

    // Content omitted under the evidence bound: the full-content hash was
    // still captured and must be present for the state to be verifiable.
    if (!hash) {
      issues.push(`${side}_hash_missing`);
      return { present: true, contentState: 'unavailable', readOutcome, size, byteLength, hash: null };
    }
    return { present: true, contentState: 'omitted_evidence_bound', readOutcome, size, byteLength, hash };
  }

  switch (readOutcome) {
    case 'not_found':
      return { present: false, contentState: 'absent', readOutcome, size: null, byteLength: null, hash: null };
    case 'not_a_regular_file':
      return { present: false, contentState: 'not_a_regular_file', readOutcome, size: null, byteLength: null, hash: null };
    case 'sensitive_blocked':
      return { present: false, contentState: 'blocked_sensitive', readOutcome, size: null, byteLength: null, hash: null };
    case 'size_exceeded':
      // Present on disk at capture time but beyond the broker's read limit:
      // no content and no hash were ever captured.
      return { present: true, contentState: 'oversized_broker_limit', readOutcome, size: null, byteLength: null, hash: null };
    case 'unreadable':
      return { present: false, contentState: 'unreadable', readOutcome, size: null, byteLength: null, hash: null };
    default:
      issues.push(`${side}_state_unknown`);
      return { present: false, contentState: 'unavailable', readOutcome, size: null, byteLength: null, hash: null };
  }
}

function changeTypeFor(before, after, integrityMalformed) {
  if (integrityMalformed) return 'metadata_only';
  if (!before.present && after.present) return 'created';
  if (before.present && !after.present) return 'deleted';
  if (before.present && after.present) {
    if (before.hash && after.hash) {
      return before.hash === after.hash ? 'unchanged' : 'modified';
    }
    if (
      before.contentState === 'included' &&
      after.contentState === 'included' &&
      typeof before.content === 'string' &&
      typeof after.content === 'string'
    ) {
      return before.content === after.content ? 'unchanged' : 'modified';
    }
    // Change cannot be attested from evidence alone (e.g. a side captured
    // beyond the broker's read limit carries no hash).
    return 'metadata_only';
  }
  // Neither side present: 'unchanged' only when both sides were genuinely
  // absent at capture time; any other shape (blocked/unavailable) cannot
  // attest what happened, so it degrades to metadata-only.
  return before.contentState === 'absent' && after.contentState === 'absent'
    ? 'unchanged'
    : 'metadata_only';
}

function contentUnavailableReason(before, after, changeType) {
  const beforeAvailable = before.contentState === 'included';
  const afterAvailable = after.contentState === 'included';

  if (changeType === 'created') {
    return afterAvailable ? null : 'content_unavailable_after';
  }
  if (changeType === 'deleted') {
    return beforeAvailable ? null : 'content_unavailable_before';
  }
  if (changeType === 'modified') {
    if (beforeAvailable && afterAvailable) return null;
    if (!beforeAvailable && !afterAvailable) return 'content_unavailable_both';
    return beforeAvailable ? 'content_unavailable_after' : 'content_unavailable_before';
  }
  if (changeType === 'metadata_only') {
    return 'hashes_unavailable';
  }
  return null;
}

// Deterministic structured line diff: common prefix/suffix trimming followed by
// a bounded LCS over the differing middle. Same inputs always yield the same
// lines. Returns null when the middle exceeds the computation bound.
function structuredLineDiff(beforeLines, afterLines) {
  const n = beforeLines.length;
  const m = afterLines.length;

  let start = 0;
  while (start < n && start < m && beforeLines[start] === afterLines[start]) start += 1;

  let endBefore = n;
  let endAfter = m;
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const beforeMid = beforeLines.slice(start, endBefore);
  const afterMid = afterLines.slice(start, endAfter);

  if (beforeMid.length * afterMid.length > MAX_LCS_CELLS) {
    return null;
  }

  const lines = [];
  for (let i = 0; i < start; i += 1) {
    lines.push({ type: 'context', before: i + 1, after: i + 1, text: beforeLines[i] });
  }

  const rows = beforeMid.length;
  const cols = afterMid.length;
  const width = cols + 1;
  const dp = new Int32Array((rows + 1) * width);

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * width + j] = beforeMid[i] === afterMid[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (beforeMid[i] === afterMid[j]) {
      lines.push({ type: 'context', before: start + i + 1, after: start + j + 1, text: beforeMid[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      lines.push({ type: 'del', before: start + i + 1, after: null, text: beforeMid[i] });
      i += 1;
    } else {
      lines.push({ type: 'add', before: null, after: start + j + 1, text: afterMid[j] });
      j += 1;
    }
  }
  while (i < rows) {
    lines.push({ type: 'del', before: start + i + 1, after: null, text: beforeMid[i] });
    i += 1;
  }
  while (j < cols) {
    lines.push({ type: 'add', before: null, after: start + j + 1, text: afterMid[j] });
    j += 1;
  }
  for (let k = 0; k < n - endBefore; k += 1) {
    lines.push({
      type: 'context',
      before: endBefore + k + 1,
      after: endAfter + k + 1,
      text: beforeLines[endBefore + k]
    });
  }

  return lines;
}

function diffFor(changeType, before, after, integrityMalformed) {
  if (integrityMalformed) {
    return { kind: 'none', reason: 'evidence_malformed' };
  }

  if (changeType === 'unchanged') {
    return { kind: 'none', reason: 'unchanged' };
  }

  if (changeType === 'metadata_only') {
    return { kind: 'none', reason: contentUnavailableReason(before, after, changeType) };
  }

  const unavailableReason = contentUnavailableReason(before, after, changeType);
  if (unavailableReason) {
    return { kind: 'none', reason: unavailableReason };
  }

  const beforeLines = before.contentState === 'included' ? toLines(before.content) : [];
  const afterLines = after.contentState === 'included' ? toLines(after.content) : [];

  if (beforeLines.length > MAX_DIFF_LINES_PER_SIDE || afterLines.length > MAX_DIFF_LINES_PER_SIDE) {
    return {
      kind: 'none',
      reason: 'line_count_exceeds_diff_bound',
      beforeLineCount: beforeLines.length,
      afterLineCount: afterLines.length
    };
  }

  if (changeType === 'created') {
    return {
      kind: 'lines',
      lines: afterLines.map((text, index) => ({ type: 'add', before: null, after: index + 1, text }))
    };
  }

  if (changeType === 'deleted') {
    return {
      kind: 'lines',
      lines: beforeLines.map((text, index) => ({ type: 'del', before: index + 1, after: null, text }))
    };
  }

  const lines = structuredLineDiff(beforeLines, afterLines);
  if (!lines) {
    return {
      kind: 'none',
      reason: 'line_count_exceeds_diff_bound',
      beforeLineCount: beforeLines.length,
      afterLineCount: afterLines.length
    };
  }
  return { kind: 'lines', lines };
}

/**
 * Transforms one durable evidence record (as returned by
 * store.getFileChangeEvidence) into a deterministic, API-safe diff object.
 * Throws only on records missing the minimal identity fields; every captured
 * state irregularity is expressed through integrity/contentState/diff metadata
 * instead, so persistence corruption can never masquerade as a real diff.
 */
export function buildChangeDiff(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('A file change evidence record is required.');
  }

  const identityFields = ['id', 'toolActionId', 'taskId', 'toolName', 'operation', 'relativePath'];
  for (const field of identityFields) {
    if (typeof record[field] !== 'string' || !record[field]) {
      throw new Error(`File change evidence record is missing ${field}.`);
    }
  }

  const issues = [];
  const before = mapCapturedState(record.beforeState, record.beforeHash, 'before', issues);
  const after = mapCapturedState(record.afterState, record.afterHash, 'after', issues);
  const integrityMalformed = issues.length > 0;

  const changeType = changeTypeFor(before, after, integrityMalformed);

  // Content is stripped from the mapped sides before response assembly: it is
  // re-added only for 'included' states, so no state shape can leak data.
  const publicBefore = { ...before };
  const publicAfter = { ...after };
  if (publicBefore.contentState !== 'included') delete publicBefore.content;
  if (publicAfter.contentState !== 'included') delete publicAfter.content;

  const result = {
    evidenceId: record.id,
    toolActionId: record.toolActionId,
    taskId: record.taskId,
    toolName: record.toolName,
    operation: record.operation,
    path: record.relativePath,
    capturedAt: typeof record.capturedAt === 'string' ? record.capturedAt : null,
    evidenceVersion: Number.isInteger(record.evidenceVersion) ? record.evidenceVersion : null,
    integrity: integrityMalformed ? 'malformed' : 'ok',
    integrityIssues: issues,
    changeType,
    before: publicBefore,
    after: publicAfter,
    // Denormalized column hashes are the persisted integrity record and are
    // always surfaced, independent of any parsed state trustworthiness.
    beforeHash: typeof record.beforeHash === 'string' && record.beforeHash ? record.beforeHash : null,
    afterHash: typeof record.afterHash === 'string' && record.afterHash ? record.afterHash : null,
    diff: diffFor(changeType, before, after, integrityMalformed)
  };

  return result;
}
