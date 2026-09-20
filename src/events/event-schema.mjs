/**
 * Real-time event schema for the Continuity Agent UI-facing event layer.
 *
 * Every event is a plain object with the shape:
 *   {
 *     id:        string   – monotonically increasing sequence number (stringified)
 *     seq:       number   – integer sequence counter (1-based)
 *     taskId:    string   – task UUID the event belongs to
 *     timestamp: string   – ISO-8601 UTC
 *     type:      string   – one of EVENT_TYPES
 *     payload:   object   – bounded, safe-for-client data (no secrets)
 *   }
 *
 * No secrets, credentials, raw unbounded tool output, or sensitive provider
 * information must ever appear in a payload.
 */

export const EVENT_TYPES = Object.freeze([
  'task_created',
  'task_updated',
  'task_state_changed',
  'checkpoint_created',
  'step_started',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'model_switching',
  'model_switched',
  'approval_required',
  'recovery_required',
  'task_completed',
  'task_failed',
  'task_paused'
]);

// Payload limits
export const MAX_PAYLOAD_STRING  = 1200;
export const MAX_PAYLOAD_DETAIL  = 2400;
export const MAX_PAYLOAD_MESSAGE =  500;
export const MAX_STEP_DETAIL     = 1200;

// Recursive sanitization bounds
const SANITIZE_MAX_DEPTH    = 4;
const SANITIZE_MAX_ARRAY    = 20;
const SANITIZE_MAX_KEYS     = 30;
const SANITIZE_MAX_STR_LEN  = 2400;

// Sensitive key pattern – must never appear in event payloads (at any depth)
const SENSITIVE_KEY_PATTERN =
  /(?:password|secret|token|credential|auth(?:orization)?|apikey|api_key|private(?:_key)?|bearer|access_key|client_secret)/i;

/**
 * Recursively strips keys matching the sensitive key pattern.
 * Bounded by depth, array length, and object key count to prevent payload explosion.
 *
 * @param {unknown} obj  – value to sanitize
 * @param {number}  [depth=0] – current recursion depth (internal)
 * @returns {unknown} sanitized copy
 */
export function stripSensitiveKeys(obj, depth = 0) {
  if (depth > SANITIZE_MAX_DEPTH) return '[DEPTH_LIMIT]';
  if (obj === null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj
      .slice(0, SANITIZE_MAX_ARRAY)
      .map(item => stripSensitiveKeys(item, depth + 1));
  }

  const entries = Object.entries(obj);
  const out = {};
  let keysEmitted = 0;
  for (const [k, v] of entries) {
    if (keysEmitted >= SANITIZE_MAX_KEYS) break;
    if (SENSITIVE_KEY_PATTERN.test(k)) continue;
    // For string values, bound their length; recurse into objects/arrays
    if (typeof v === 'string') {
      out[k] = v.slice(0, SANITIZE_MAX_STR_LEN);
    } else {
      out[k] = stripSensitiveKeys(v, depth + 1);
    }
    keysEmitted += 1;
  }
  return out;
}

export function sanitizeTaskPayload(task) {
  if (!task || typeof task !== 'object') return {};
  return {
    id:              String(task.id || '').slice(0, 100),
    goal:            String(task.goal || '').slice(0, MAX_PAYLOAD_STRING),
    status:          String(task.status || '').slice(0, 50),
    message:         String(task.message || '').slice(0, MAX_PAYLOAD_MESSAGE),
    activeModel:     String(task.activeModel || '').slice(0, 200),
    createdAt:       String(task.createdAt || '').slice(0, 50),
    updatedAt:       String(task.updatedAt || '').slice(0, 50),
    stepCount:       Array.isArray(task.steps)       ? task.steps.length       : 0,
    checkpointCount: Array.isArray(task.checkpoints) ? task.checkpoints.length : 0
  };
}

export function sanitizeTaskSnapshot(task) {
  if (!task || typeof task !== 'object') return null;
  return {
    id:              String(task.id || '').slice(0, 100),
    goal:            String(task.goal || '').slice(0, MAX_PAYLOAD_STRING),
    status:          String(task.status || '').slice(0, 50),
    message:         String(task.message || '').slice(0, MAX_PAYLOAD_MESSAGE),
    activeModel:     String(task.activeModel || '').slice(0, 200),
    createdAt:       String(task.createdAt || '').slice(0, 50),
    updatedAt:       String(task.updatedAt || '').slice(0, 50),
    steps:           Array.isArray(task.steps)
      ? task.steps.slice(-20).map(sanitizeStepPayload)
      : [],
    checkpoints:     Array.isArray(task.checkpoints)
      ? task.checkpoints.slice(-20).map(sanitizeCheckpointPayload)
      : [],
    stepCount:       Array.isArray(task.steps)       ? task.steps.length       : 0,
    checkpointCount: Array.isArray(task.checkpoints) ? task.checkpoints.length : 0
  };
}

export function sanitizeApprovalRequest(approval) {
  if (!approval || typeof approval !== 'object') return null;

  const expiresAtMs = Date.parse(String(approval.expiresAt || ''));
  const expired =
    !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs;

  return {
    id: String(approval.id || '').slice(0, 100),
    taskId: String(approval.taskId || '').slice(0, 100),
    toolActionId: String(approval.toolActionId || '').slice(0, 100),
    toolName: String(approval.toolName || '').slice(0, 100),
    argumentsHash: String(approval.argumentsHash || '').slice(0, 64),
    status: String(approval.status || '').slice(0, 30),
    expired,
    canResolve: approval.status === 'pending' && !expired,
    createdAt: String(approval.createdAt || '').slice(0, 50),
    expiresAt: String(approval.expiresAt || '').slice(0, 50),
    resolvedAt:
      approval.resolvedAt === null || approval.resolvedAt === undefined
        ? null
        : String(approval.resolvedAt).slice(0, 50),
    resolutionReason:
      approval.resolutionReason === null ||
      approval.resolutionReason === undefined
        ? null
        : String(approval.resolutionReason).slice(0, 500),
    args: stripSensitiveKeys(
      approval.args && typeof approval.args === 'object'
        ? approval.args
        : {}
    )
  };
}

export function sanitizeRecoveryToolAction(action, evidence = null) {
  if (!action || typeof action !== 'object') return null;

  const errorText = String(action.error || '').trim();
  const lowerError = errorText.toLowerCase();

  let reason =
    'Tool action outcome is uncertain and requires manual verification.';

  if (lowerError.includes('evidence')) {
    reason = 'Durable change evidence was not persisted.';
  } else if (errorText) {
    reason =
      'Tool execution ended before a verified durable success record was persisted.';
  }

  const safeEvidence = evidence
    ? {
        available: true,
        id: String(evidence.id || '').slice(0, 100),
        operation: String(evidence.operation || '').slice(0, 50),
        relativePath: String(evidence.relativePath || '').slice(0, 500),
        evidenceVersion: Number.isInteger(evidence.evidenceVersion)
          ? evidence.evidenceVersion
          : null,
        beforeHash: String(evidence.beforeHash || '').slice(0, 64) || null,
        afterHash: String(evidence.afterHash || '').slice(0, 64) || null,
        capturedAt: String(evidence.capturedAt || '').slice(0, 50)
      }
    : {
        available: false,
        id: null,
        operation: null,
        relativePath: null,
        evidenceVersion: null,
        beforeHash: null,
        afterHash: null,
        capturedAt: null
      };

  return {
    id: String(action.id || '').slice(0, 100),
    taskId: String(action.taskId || '').slice(0, 100),
    toolName: String(action.toolName || '').slice(0, 100),
    toolCallId: action.toolCallId
      ? String(action.toolCallId).slice(0, 100)
      : null,
    policyDecision: String(action.policyDecision || '').slice(0, 50),
    status: String(action.status || '').slice(0, 30),
    startedAt: String(action.startedAt || '').slice(0, 50),
    finishedAt: String(action.finishedAt || '').slice(0, 50),
    hasError: Boolean(errorText),
    reason,
    args: stripSensitiveKeys(
      action.args && typeof action.args === 'object'
        ? action.args
        : {}
    ),
    evidence: safeEvidence
  };
}

export const MAX_TRANSCRIPT_MESSAGES = 50;

const MAX_TRANSCRIPT_CONTENT = 4000;
const MAX_TRANSCRIPT_TOOL_CALLS = 10;
const MAX_TRANSCRIPT_TOOL_CALL_STRING = 2400;

export function sanitizeTaskTranscriptMessage(record) {
  if (!record || typeof record !== 'object') return {};

  const message =
    record.message &&
    typeof record.message === 'object' &&
    !Array.isArray(record.message)
      ? record.message
      : {};

  const safeMessage = {
    role: String(message.role || '').slice(0, 30)
  };

  if (typeof message.content === 'string') {
    safeMessage.content = message.content.slice(0, MAX_TRANSCRIPT_CONTENT);
  }

  if (typeof message.tool_call_id === 'string') {
    safeMessage.tool_call_id =
      message.tool_call_id.slice(0, 200);
  }

  if (Array.isArray(message.tool_calls)) {
    safeMessage.tool_calls = message.tool_calls
      .slice(0, MAX_TRANSCRIPT_TOOL_CALLS)
      .map(call => {
        if (!call || typeof call !== 'object' || Array.isArray(call)) {
          return {};
        }

        const safeCall = {
          id: typeof call.id === 'string'
            ? call.id.slice(0, 200)
            : '',
          type: typeof call.type === 'string'
            ? call.type.slice(0, 50)
            : ''
        };

        if (
          call.function &&
          typeof call.function === 'object' &&
          !Array.isArray(call.function)
        ) {
          const safeFunction = {
            name: typeof call.function.name === 'string'
              ? call.function.name.slice(0, 200)
              : ''
          };

          if (typeof call.function.arguments === 'string') {
            try {
              const parsed = JSON.parse(call.function.arguments);
              safeFunction.arguments = JSON.stringify(
                stripSensitiveKeys(parsed)
              ).slice(0, MAX_TRANSCRIPT_TOOL_CALL_STRING);
            } catch {
              safeFunction.arguments =
                '[continuity-agent: tool arguments redacted]';
            }
          } else if (
            call.function.arguments &&
            typeof call.function.arguments === 'object' &&
            !Array.isArray(call.function.arguments)
          ) {
            safeFunction.arguments = JSON.stringify(
              stripSensitiveKeys(call.function.arguments)
            ).slice(0, MAX_TRANSCRIPT_TOOL_CALL_STRING);
          }

          safeCall.function = safeFunction;
        }

        return safeCall;
      });
  }

  return {
    id: String(record.id || '').slice(0, 100),
    taskId: String(record.taskId || '').slice(0, 100),
    sequence: Number.isInteger(record.sequence)
      ? record.sequence
      : 0,
    createdAt: String(record.createdAt || '').slice(0, 50),
    message: safeMessage
  };
}

export function sanitizeCheckpointPayload(cp) {
  if (!cp || typeof cp !== 'object') return {};
  return {
    id:        String(cp.id    || '').slice(0, 100),
    event:     String(cp.event || '').slice(0, MAX_PAYLOAD_STRING),
    status:    String(cp.status || '').slice(0, 50),
    step:      Number(cp.step) || 0,
    createdAt: String(cp.createdAt || '').slice(0, 50)
  };
}

export function sanitizeStepPayload(step) {
  if (!step || typeof step !== 'object') return {};
  const safe = {
    kind:   String(step.kind   || '').slice(0, 50),
    name:   String(step.name   || '').slice(0, 200),
    at:     String(step.at     || '').slice(0, 50),
    detail: String(step.detail || '').slice(0, MAX_STEP_DETAIL)
  };
  if (step.replayed === true) safe.replayed = true;
  return safe;
}

export function isValidEventType(type) {
  return EVENT_TYPES.includes(type);
}

export function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['Event must be a plain object'] };
  }
  if (typeof event.id !== 'string' || !event.id)           errors.push('Missing id');
  if (!Number.isInteger(event.seq) || event.seq < 1)       errors.push('seq must be a positive integer');
  if (typeof event.taskId !== 'string' || !event.taskId)   errors.push('Missing taskId');
  if (typeof event.timestamp !== 'string' || !event.timestamp) errors.push('Missing timestamp');
  if (!isValidEventType(event.type))                       errors.push(`Unknown event type: ${event.type}`);
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    errors.push('payload must be a plain object');
  }
  return { valid: errors.length === 0, errors };
}

export function buildStateChangedPayload(previousStatus, nextStatus, message) {
  return {
    previousStatus: String(previousStatus || '').slice(0, 50),
    nextStatus:     String(nextStatus     || '').slice(0, 50),
    message:        String(message        || '').slice(0, MAX_PAYLOAD_MESSAGE)
  };
}

export function buildModelSwitchPayload(previousModel, targetModel, reason) {
  return {
    previousModel: String(previousModel || '').slice(0, 200),
    targetModel:   String(targetModel   || '').slice(0, 200),
    reason:        String(reason        || '').slice(0, MAX_PAYLOAD_STRING)
  };
}

export function buildToolPayload(toolName, detail, extra = {}) {
  // Sanitize extra first, then place protected fields LAST so they cannot be overridden.
  const sanitizedExtra = stripSensitiveKeys(extra);
  // Remove toolName and detail from extra even if present after sanitization
  const { toolName: _tn, detail: _d, ...safeExtra } = (sanitizedExtra && typeof sanitizedExtra === 'object' && !Array.isArray(sanitizedExtra))
    ? sanitizedExtra
    : {};
  return {
    ...safeExtra,
    toolName: String(toolName || '').slice(0, 200),
    detail:   String(detail   || '').slice(0, MAX_PAYLOAD_DETAIL)
  };
}

export function buildStepStartedPayload(step, activeModel) {
  return {
    step: Number.isInteger(step) ? step : 0,
    activeModel: String(activeModel || '').slice(0, 200)
  };
}
