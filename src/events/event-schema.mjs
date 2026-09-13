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
