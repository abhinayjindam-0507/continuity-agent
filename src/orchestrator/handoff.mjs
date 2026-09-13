import { isTerminal } from '../task-state.mjs';

export const MAX_RECENT_ITEMS = 10;
export const MAX_STRING_LENGTH = 1000;
export const MAX_DETAIL_LENGTH = 500;
export const MAX_SHORT_STRING_LENGTH = 128;

export function clampBound(value, defaultValue, maxBound) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return defaultValue;
  }
  if (value < 0) {
    return defaultValue;
  }
  if (value > maxBound) {
    return maxBound;
  }
  return value;
}

function truncateString(val, maxLength = MAX_STRING_LENGTH) {
  if (val == null) return '';
  const str = typeof val === 'string' ? val : String(val);
  if (maxLength <= 0) return '';
  return str.length <= maxLength ? str : str.slice(0, maxLength);
}

function deriveStepNumber(task) {
  if (typeof task?.currentStepNumber === 'number' && Number.isFinite(task.currentStepNumber)) {
    return Math.max(0, Math.floor(task.currentStepNumber));
  }
  if (typeof task?.currentStep === 'number' && Number.isFinite(task.currentStep)) {
    return Math.max(0, Math.floor(task.currentStep));
  }
  if (typeof task?.stepNumber === 'number' && Number.isFinite(task.stepNumber)) {
    return Math.max(0, Math.floor(task.stepNumber));
  }
  if (typeof task?.step === 'number' && Number.isFinite(task.step)) {
    return Math.max(0, Math.floor(task.step));
  }
  if (Array.isArray(task?.steps)) {
    return task.steps.length;
  }
  return 0;
}

function sanitizeStep(step, maxDetailLength = MAX_DETAIL_LENGTH) {
  if (!step || typeof step !== 'object') return null;
  const clean = {};
  const at = step.at || step.createdAt || step.timestamp || step.time;
  if (at) clean.at = truncateString(at, 64);
  if (step.kind) clean.kind = truncateString(step.kind, 64);
  if (step.model) clean.model = truncateString(step.model, MAX_SHORT_STRING_LENGTH);
  if (step.name) clean.name = truncateString(step.name, MAX_SHORT_STRING_LENGTH);
  if (step.detail != null) clean.detail = truncateString(step.detail, maxDetailLength);
  if (step.errorType) clean.errorType = truncateString(step.errorType, 64);
  if (typeof step.retryAttempt === 'number') clean.retryAttempt = step.retryAttempt;
  return clean;
}

function sanitizeCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const clean = {};
  if (checkpoint.id) clean.id = truncateString(checkpoint.id, 64);
  const time = checkpoint.createdAt || checkpoint.at || checkpoint.time;
  if (time) {
    clean.time = truncateString(time, 64);
    clean.createdAt = clean.time;
  }
  if (checkpoint.event) clean.event = truncateString(checkpoint.event, 256);
  if (checkpoint.status) clean.status = truncateString(checkpoint.status, 64);
  if (checkpoint.activeModel) clean.activeModel = truncateString(checkpoint.activeModel, MAX_SHORT_STRING_LENGTH);
  if (typeof checkpoint.step === 'number') clean.step = checkpoint.step;
  return clean;
}

function sanitizeModelSwitch(sw, maxDetailLength = MAX_DETAIL_LENGTH) {
  if (!sw || typeof sw !== 'object') return null;
  const clean = {};
  const at = sw.at || sw.createdAt || sw.time;
  if (at) clean.at = truncateString(at, 64);
  if (sw.model) clean.model = truncateString(sw.model, MAX_SHORT_STRING_LENGTH);
  if (sw.fromModel) clean.fromModel = truncateString(sw.fromModel, MAX_SHORT_STRING_LENGTH);
  if (sw.toModel) clean.toModel = truncateString(sw.toModel, MAX_SHORT_STRING_LENGTH);
  if (sw.reason) clean.reason = truncateString(sw.reason, maxDetailLength);
  return clean;
}

function sanitizeError(err, maxDetailLength = MAX_DETAIL_LENGTH) {
  if (!err) return null;
  if (typeof err === 'string') {
    return {
      message: truncateString(err, maxDetailLength)
    };
  }
  if (typeof err !== 'object') {
    return {
      message: truncateString(String(err), maxDetailLength)
    };
  }
  const clean = {};
  const at = err.at || err.createdAt || err.timestamp || err.time;
  if (at) clean.at = truncateString(at, 64);
  const kind = err.kind || err.errorType || err.type;
  if (kind) clean.type = truncateString(kind, 64);
  if (err.model) clean.model = truncateString(err.model, MAX_SHORT_STRING_LENGTH);
  if (err.name) clean.name = truncateString(err.name, MAX_SHORT_STRING_LENGTH);
  const msg = err.message || err.detail || err.error || '';
  if (msg) clean.message = truncateString(msg, maxDetailLength);
  return clean;
}

function findLatestCheckpoint(checkpoints) {
  if (!Array.isArray(checkpoints)) return null;
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const cp = checkpoints[i];
    if (cp && typeof cp === 'object') return cp;
  }
  return null;
}

function takeRecent(array, limit) {
  if (!Array.isArray(array) || limit <= 0) return [];
  return array.slice(-limit);
}

function extractRecentErrors(task, limit, maxDetailLength) {
  if (limit <= 0) return [];
  const errors = [];
  const seen = new Set();

  function addError(raw) {
    if (!raw) return;
    if (typeof raw === 'object') {
      if (seen.has(raw)) return;
      seen.add(raw);
    }
    const sanitized = sanitizeError(raw, maxDetailLength);
    if (sanitized) {
      errors.push(sanitized);
    }
  }

  if (Array.isArray(task?.errors)) {
    for (const err of task.errors) {
      addError(err);
    }
  }

  if (Array.isArray(task?.steps)) {
    for (const step of task.steps) {
      if (!step || typeof step !== 'object') continue;
      const isError =
        step.kind === 'model_error' ||
        step.kind === 'tool_error' ||
        (typeof step.kind === 'string' && step.kind.includes('error')) ||
        Boolean(step.error) ||
        Boolean(step.errorType);

      if (isError) {
        addError({
          at: step.at || step.createdAt || step.timestamp,
          type: step.errorType || step.kind || 'error',
          model: step.model,
          name: step.name,
          message: step.detail || step.message || step.error
        });
      }
    }
  }

  if (task?.lastError) {
    addError(task.lastError);
  } else if (task?.error) {
    addError(task.error);
  }

  return errors.slice(-limit);
}

function deriveRecommendedAction(status, hasErrors) {
  switch (status) {
    case 'completed':
    case 'failed':
      return 'none';
    case 'awaiting_approval':
      return 'await_approval';
    case 'needs_setup':
      return 'configure_model';
    case 'switching_model':
      return 'validate_model_switch';
    case 'validating_handoff':
      return 'validate_handoff';
    case 'paused':
      return hasErrors ? 'review_errors_and_resume' : 'resume';
    case 'running':
      return 'continue';
    case 'planning':
      return 'continue_planning';
    case 'queued':
      return 'start';
    default:
      return isTerminal(status) ? 'none' : 'resume';
  }
}

function deriveResumeContext(task, currentStatus, currentStepNumber, latestCheckpoint, recentErrors, maxDetailLength = MAX_DETAIL_LENGTH) {
  const terminal = isTerminal(currentStatus);
  const totalSteps = Array.isArray(task?.steps) ? task.steps.length : currentStepNumber;
  const totalCheckpoints = Array.isArray(task?.checkpoints) ? task.checkpoints.length : (latestCheckpoint ? 1 : 0);
  const switches = Array.isArray(task?.switches)
    ? task.switches
    : Array.isArray(task?.modelSwitches)
      ? task.modelSwitches
      : [];
  const totalSwitches = switches.length;
  const hasErrors = recentErrors.length > 0;
  const recommendedAction = deriveRecommendedAction(currentStatus, hasErrors);

  return {
    canResume: !terminal,
    status: currentStatus,
    stepNumber: currentStepNumber,
    activeModel: truncateString(task?.activeModel || '', MAX_SHORT_STRING_LENGTH),
    lastCheckpointEvent: latestCheckpoint?.event ?? null,
    lastCheckpointTime: latestCheckpoint?.time ?? null,
    lastMessage: truncateString(task?.message || '', maxDetailLength),
    totalSteps,
    totalCheckpoints,
    totalSwitches,
    errorCount: recentErrors.length,
    hasErrors,
    recommendedAction
  };
}

export function createHandoffPacket(task, options = {}) {
  const safeTask = task && typeof task === 'object' ? task : {};
  const safeOptions = options && typeof options === 'object' ? options : {};

  const maxRecentItems = clampBound(safeOptions.maxRecentItems, MAX_RECENT_ITEMS, MAX_RECENT_ITEMS);
  const maxStringLength = clampBound(safeOptions.maxStringLength, MAX_STRING_LENGTH, MAX_STRING_LENGTH);
  const maxDetailLength = clampBound(safeOptions.maxDetailLength, MAX_DETAIL_LENGTH, MAX_DETAIL_LENGTH);

  const taskId = truncateString(safeTask.id || safeTask.taskId || '', MAX_SHORT_STRING_LENGTH);
  const originalGoal = truncateString(safeTask.goal || safeTask.originalGoal || '', maxStringLength);
  const currentStatus = truncateString(safeTask.status || safeTask.currentStatus || 'draft', MAX_SHORT_STRING_LENGTH);
  const activeModel = truncateString(safeTask.activeModel || '', MAX_SHORT_STRING_LENGTH);
  const currentStepNumber = deriveStepNumber(safeTask);

  const rawLatest = findLatestCheckpoint(safeTask.checkpoints);
  const latestCheckpoint = rawLatest
    ? {
        event: truncateString(rawLatest.event, 256),
        time: truncateString(rawLatest.createdAt || rawLatest.at || rawLatest.time || '', 64),
        createdAt: truncateString(rawLatest.createdAt || rawLatest.at || rawLatest.time || '', 64),
        step: typeof rawLatest.step === 'number' ? rawLatest.step : undefined
      }
    : null;

  const latestCheckpointEvent = latestCheckpoint ? latestCheckpoint.event : null;
  const latestCheckpointTime = latestCheckpoint ? latestCheckpoint.time : null;

  const rawSteps = Array.isArray(safeTask.steps)
    ? safeTask.steps.filter(s => s && typeof s === 'object')
    : [];
  const recentSteps = takeRecent(rawSteps, maxRecentItems)
    .map(s => sanitizeStep(s, maxDetailLength));

  const rawCheckpoints = Array.isArray(safeTask.checkpoints)
    ? safeTask.checkpoints.filter(c => c && typeof c === 'object')
    : [];
  const recentCheckpoints = takeRecent(rawCheckpoints, maxRecentItems)
    .map(c => sanitizeCheckpoint(c));

  const rawSwitches = Array.isArray(safeTask.switches)
    ? safeTask.switches.filter(s => s && typeof s === 'object')
    : Array.isArray(safeTask.modelSwitches)
      ? safeTask.modelSwitches.filter(s => s && typeof s === 'object')
      : [];
  const recentModelSwitches = takeRecent(rawSwitches, maxRecentItems)
    .map(s => sanitizeModelSwitch(s, maxDetailLength));

  const recentErrors = extractRecentErrors(safeTask, maxRecentItems, maxDetailLength);

  const resumeContext = deriveResumeContext(
    safeTask,
    currentStatus,
    currentStepNumber,
    latestCheckpoint,
    recentErrors,
    maxDetailLength
  );

  return {
    taskId,
    originalGoal,
    currentStatus,
    activeModel,
    currentStepNumber,
    latestCheckpoint,
    latestCheckpointEvent,
    latestCheckpointTime,
    recentSteps,
    recentCheckpoints,
    recentModelSwitches,
    recentErrors,
    resumeContext,
    // Convenience aliases
    id: taskId,
    goal: originalGoal,
    status: currentStatus,
    currentStep: currentStepNumber,
    stepNumber: currentStepNumber,
    recentSwitches: recentModelSwitches
  };
}
