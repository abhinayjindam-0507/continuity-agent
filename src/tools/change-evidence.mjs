import { createHash } from 'node:crypto';

export const FILE_CHANGE_EVIDENCE_VERSION = 1;

// Evidence content bound: a captured state's content is persisted only when it
// fits within this limit; larger states are represented by their SHA-256 hash
// plus explicit metadata instead. This is deliberately smaller than the
// filesystem broker's file size limit so evidence rows stay bounded
// independently of what the broker will accept for an operation.
export const MAX_EVIDENCE_CONTENT_BYTES = 64 * 1024;

export function sha256Content(content) {
  return createHash('sha256').update(String(content), 'utf8').digest('hex');
}

// Read failures are classified into explicit, content-free outcomes so evidence
// never fabricates a state it could not observe through the filesystem broker.
function classifyReadError(message) {
  if (message.includes('not found')) {
    return { present: false, readOutcome: 'not_found' };
  }
  if (message.includes('sensitive file or directory is blocked')) {
    return { present: false, readOutcome: 'sensitive_blocked' };
  }
  if (message.includes('exceeds maximum allowed limit')) {
    return { present: true, readOutcome: 'size_exceeded' };
  }
  if (message.includes('Target is not a regular file')) {
    return { present: false, readOutcome: 'not_a_regular_file' };
  }
  return { present: false, readOutcome: 'unreadable' };
}

/**
 * Captures the actual state of a project file through the existing filesystem
 * broker — never through direct host filesystem access. The broker enforces
 * project scoping, traversal/symlink rejection, and sensitive-path protection,
 * so sensitive files can never produce captured content here.
 */
export async function captureFileState(fsBroker, relativePath) {
  if (!fsBroker || typeof fsBroker.readFile !== 'function') {
    throw new Error('captureFileState requires a filesystem broker.');
  }

  try {
    const result = await fsBroker.readFile(relativePath);
    const content = typeof result.content === 'string' ? result.content : '';
    const byteLength = Buffer.byteLength(content, 'utf8');
    const contentIncluded = byteLength <= MAX_EVIDENCE_CONTENT_BYTES;

    return {
      present: true,
      readOutcome: 'ok',
      size: Number(result.size) || byteLength,
      byteLength,
      hash: sha256Content(content),
      contentIncluded,
      ...(contentIncluded ? { content } : {})
    };
  } catch (error) {
    return {
      contentIncluded: false,
      ...classifyReadError(String(error?.message || ''))
    };
  }
}

/**
 * Builds the durable evidence record linking one successful filesystem tool
 * action to its authentic before/after states. Deterministic: identical
 * captured states produce identical evidence payloads.
 */
export function buildChangeEvidence({
  toolActionId,
  idempotencyKey,
  taskId,
  toolName,
  relativePath,
  beforeState,
  afterState,
  capturedAt = new Date().toISOString()
} = {}) {
  const operations = { write_file: 'write', patch_file: 'patch' };
  const operation = operations[toolName];

  if (!operation) {
    throw new Error(
      `Change evidence is only recorded for write_file and patch_file, not '${toolName}'.`
    );
  }
  if (!toolActionId) {
    throw new Error('Change evidence requires toolActionId.');
  }
  if (!idempotencyKey) {
    throw new Error('Change evidence requires the tool action idempotency key.');
  }
  if (!taskId) {
    throw new Error('Change evidence requires taskId.');
  }
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Change evidence requires a relative project path.');
  }
  if (!beforeState || typeof beforeState !== 'object' ||
      !afterState || typeof afterState !== 'object') {
    throw new Error('Change evidence requires captured before and after states.');
  }

  return {
    toolActionId: String(toolActionId),
    idempotencyKey: String(idempotencyKey),
    taskId: String(taskId),
    toolName: String(toolName),
    operation,
    relativePath,
    evidenceVersion: FILE_CHANGE_EVIDENCE_VERSION,
    capturedAt,
    beforeState,
    afterState
  };
}
