/**
 * Orchestrator-to-event-layer bridge.
 *
 * Translates the existing generic `emit('task', task)` calls and orchestrator
 * lifecycle activity into typed, schema-validated events on the event emitter.
 *
 * Design constraints:
 *  - Does NOT rewrite or modify orchestrator logic.
 *  - Wraps the existing `emit` injection point in server.mjs.
 *  - Keeps the original `emit(type, payload)` call-site interface intact as
 *    the orchestrator uses it, while augmenting it with typed events.
 *  - SQLite is the source of truth; this layer only fans out to SSE clients.
 */

import {
  sanitizeTaskPayload,
  sanitizeCheckpointPayload,
  buildStateChangedPayload,
  buildModelSwitchPayload,
  buildToolPayload
} from './event-schema.mjs';

/**
 * Creates a bridge that adapts orchestrator lifecycle signals into
 * typed real-time events.
 *
 * @param {object} eventEmitter  – from createEventEmitter()
 * @returns {{
 *   onTaskCreated(task): void,
 *   onTaskUpdated(task, previousStatus): void,
 *   onCheckpointCreated(taskId, cp): void,
 *   onToolStarted(taskId, toolName): void,
 *   onToolCompleted(taskId, toolName, detail): void,
 *   onToolFailed(taskId, toolName, errorMessage): void,
 *   onModelSwitching(taskId, previousModel, targetModel, reason): void,
 *   onModelSwitched(taskId, previousModel, targetModel): void,
 *   onApprovalRequired(taskId, approvalId, message): void,
 *   onRecoveryRequired(taskId, reason): void,
 *   buildLegacyEmit(): function   – drop-in for the existing emit(type, payload)
 * }}
 */
export function createOrchestratorBridge(eventEmitter) {
  const ee = eventEmitter;

  function onTaskCreated(task) {
    ee.emit(task.id, 'task_created', sanitizeTaskPayload(task));
  }

  function onTaskUpdated(task, previousStatus) {
    const next = task.status;
    const sanitized = sanitizeTaskPayload(task);

    // Always emit task_updated
    ee.emit(task.id, 'task_updated', sanitized);

    // Emit specialised state-change events when status changed
    if (previousStatus && previousStatus !== next) {
      ee.emit(task.id, 'task_state_changed', buildStateChangedPayload(
        previousStatus,
        next,
        task.message
      ));

      if (next === 'completed') {
        ee.emit(task.id, 'task_completed', {
          message: String(task.message || '').slice(0, 500)
        });
      } else if (next === 'failed') {
        ee.emit(task.id, 'task_failed', {
          message: String(task.message || '').slice(0, 500)
        });
      } else if (next === 'paused') {
        ee.emit(task.id, 'task_paused', {
          message: String(task.message || '').slice(0, 500)
        });
      }
    }
  }

  function onCheckpointCreated(taskId, cp) {
    ee.emit(taskId, 'checkpoint_created', sanitizeCheckpointPayload(cp));
  }

  function onStepStarted(taskId, step, activeModel) {
    ee.emit(taskId, 'step_started', {
      step: Number.isInteger(step) ? step : 0,
      activeModel: String(activeModel || '').slice(0, 200)
    });
  }

  function onToolStarted(taskId, toolName) {
    ee.emit(taskId, 'tool_started', buildToolPayload(toolName, ''));
  }

  function onToolCompleted(taskId, toolName, detail) {
    ee.emit(taskId, 'tool_completed', buildToolPayload(toolName, detail));
  }

  function onToolFailed(taskId, toolName, errorMessage) {
    ee.emit(taskId, 'tool_failed', buildToolPayload(toolName, errorMessage));
  }

  function onModelSwitching(taskId, previousModel, targetModel, reason) {
    ee.emit(taskId, 'model_switching',
      buildModelSwitchPayload(previousModel, targetModel, reason));
  }

  function onModelSwitched(taskId, previousModel, targetModel) {
    ee.emit(taskId, 'model_switched',
      buildModelSwitchPayload(previousModel, targetModel, ''));
  }

  function onApprovalRequired(taskId, approvalId, message) {
    ee.emit(taskId, 'approval_required', {
      approvalId: String(approvalId || '').slice(0, 100),
      message: String(message || '').slice(0, 500)
    });
  }

  function onRecoveryRequired(taskId, reason) {
    ee.emit(taskId, 'recovery_required', {
      reason: String(reason || '').slice(0, 500)
    });
  }

  /**
   * Builds a drop-in replacement for the existing `emit(type, payload)` function
   * that is injected into the orchestrator.
   *
   * Existing call-sites:
   *   emit('task', task)  – after every updateTask() in the orchestrator
   *
   * The legacy emit fan-out to the old `clients` Set is kept alive by the
   * server.mjs calling this bridge. The bridge adds typed event emission on top.
   *
   * @param {string | null} previousTaskStatus – optional; pass to emit state-change events
   */
  function buildLegacyEmit(getTaskPreviousStatus) {
    return function legacyEmit(type, payload) {
      if (type === 'task' && payload && payload.id) {
        const prev = getTaskPreviousStatus
          ? getTaskPreviousStatus(payload.id)
          : undefined;
        onTaskUpdated(payload, prev);
      }
      // Other legacy emit types (e.g. 'ready') are ignored by the bridge;
      // they may still be sent as SSE via the server's own mechanism.
    };
  }

  return {
    onTaskCreated,
    onTaskUpdated,
    onCheckpointCreated,
    onStepStarted,
    onToolStarted,
    onToolCompleted,
    onToolFailed,
    onModelSwitching,
    onModelSwitched,
    onApprovalRequired,
    onRecoveryRequired,
    buildLegacyEmit
  };
}
