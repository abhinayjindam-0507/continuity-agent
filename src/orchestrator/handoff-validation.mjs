import {
  MAX_RECENT_ITEMS,
  MAX_STRING_LENGTH,
  MAX_SHORT_STRING_LENGTH
} from './handoff.mjs';

export const VALID_STATUSES = new Set([
  'draft',
  'queued',
  'planning',
  'running',
  'awaiting_approval',
  'switching_model',
  'validating_handoff',
  'needs_setup',
  'paused',
  'completed',
  'failed'
]);

export function validateHandoffPacket(packet) {
  const errors = [];
  const warnings = [];

  // 1. Packet exists
  if (!packet || typeof packet !== 'object') {
    return {
      valid: false,
      errors: ['Handoff packet must be a non-null object.'],
      warnings: []
    };
  }

  // 2. Required identifiers / status fields
  const taskId = packet.taskId ?? packet.id;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    errors.push('taskId must be a non-empty string.');
  } else if (taskId.length > MAX_SHORT_STRING_LENGTH) {
    errors.push(`taskId exceeds maximum allowed length (${MAX_SHORT_STRING_LENGTH}).`);
  }

  const goal = packet.originalGoal ?? packet.goal;
  if (typeof goal !== 'string') {
    errors.push('originalGoal must be a string.');
  } else if (goal.length > MAX_STRING_LENGTH) {
    errors.push(`originalGoal exceeds maximum allowed length (${MAX_STRING_LENGTH}).`);
  }

  const status = packet.currentStatus ?? packet.status;
  if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
    errors.push('currentStatus must be a valid task status.');
  }

  if (packet.activeModel !== undefined && packet.activeModel !== null) {
    if (typeof packet.activeModel !== 'string') {
      errors.push('activeModel must be a string.');
    } else if (packet.activeModel.length > MAX_SHORT_STRING_LENGTH) {
      errors.push(`activeModel exceeds maximum allowed length (${MAX_SHORT_STRING_LENGTH}).`);
    }
  }

  // 3. Current step information is internally consistent
  const stepNumber = packet.currentStepNumber ?? packet.currentStep ?? packet.stepNumber;
  if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber) || stepNumber < 0) {
    errors.push('currentStepNumber must be a non-negative integer.');
  }

  if (packet.latestCheckpoint !== undefined && packet.latestCheckpoint !== null) {
    if (typeof packet.latestCheckpoint !== 'object') {
      errors.push('latestCheckpoint must be an object or null.');
    } else {
      if (
        packet.latestCheckpoint.step !== undefined &&
        (typeof packet.latestCheckpoint.step !== 'number' ||
          !Number.isInteger(packet.latestCheckpoint.step) ||
          packet.latestCheckpoint.step < 0)
      ) {
        errors.push('latestCheckpoint.step must be a non-negative integer.');
      }
      if (
        packet.latestCheckpoint.event !== undefined &&
        typeof packet.latestCheckpoint.event !== 'string'
      ) {
        errors.push('latestCheckpoint.event must be a string.');
      }
      if (
        typeof stepNumber === 'number' &&
        typeof packet.latestCheckpoint.step === 'number' &&
        packet.latestCheckpoint.step > stepNumber
      ) {
        warnings.push('latestCheckpoint step exceeds currentStepNumber.');
      }
    }
  }

  // 4. Recent collections are arrays and remain within their allowed bounds
  const collections = [
    { name: 'recentSteps', value: packet.recentSteps },
    { name: 'recentCheckpoints', value: packet.recentCheckpoints },
    { name: 'recentModelSwitches', value: packet.recentModelSwitches ?? packet.recentSwitches },
    { name: 'recentErrors', value: packet.recentErrors }
  ];

  for (const { name, value } of collections) {
    if (!Array.isArray(value)) {
      errors.push(`${name} must be an array.`);
    } else if (value.length > MAX_RECENT_ITEMS) {
      errors.push(`${name} exceeds maximum allowed items (${MAX_RECENT_ITEMS}).`);
    } else if (value.some(item => !item || typeof item !== 'object')) {
      errors.push(`${name} entries must be valid objects.`);
    }
  }

  // 5. resumeContext exists and is coherent
  if (!packet.resumeContext || typeof packet.resumeContext !== 'object') {
    errors.push('resumeContext must be a non-null object.');
  } else {
    if (typeof packet.resumeContext.canResume !== 'boolean') {
      errors.push('resumeContext.canResume must be a boolean.');
    }
    if (
      typeof packet.resumeContext.status !== 'string' ||
      !VALID_STATUSES.has(packet.resumeContext.status)
    ) {
      errors.push('resumeContext.status must be a valid task status.');
    }
    if (
      typeof packet.resumeContext.stepNumber !== 'number' ||
      !Number.isInteger(packet.resumeContext.stepNumber) ||
      packet.resumeContext.stepNumber < 0
    ) {
      errors.push('resumeContext.stepNumber must be a non-negative integer.');
    }

    // Coherence check: terminal status must not allow resume
    if (
      (status === 'completed' || status === 'failed') &&
      packet.resumeContext.canResume === true
    ) {
      errors.push('resumeContext.canResume must be false for terminal task status.');
    }

    if (
      typeof status === 'string' &&
      typeof packet.resumeContext.status === 'string' &&
      status !== packet.resumeContext.status
    ) {
      warnings.push('resumeContext.status does not match packet currentStatus.');
    }

    if (
      typeof stepNumber === 'number' &&
      typeof packet.resumeContext.stepNumber === 'number' &&
      stepNumber !== packet.resumeContext.stepNumber
    ) {
      warnings.push('resumeContext.stepNumber does not match currentStepNumber.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export const validateHandoff = validateHandoffPacket;
