import { randomUUID } from 'node:crypto';
import { assertTransition, transitionTask } from '../task-state.mjs';
import { shouldFallbackProviderError } from '../router/fallback-policy.mjs';
import {
  canRetry,
  nextRetryDelayMs
} from '../router/retry-policy.mjs';
import { createHandoffPacket } from './handoff.mjs';
import { validateHandoffPacket } from './handoff-validation.mjs';
import { computeCheckpointHash } from '../store.mjs';
import { authorizeTool } from '../policy.mjs';
import {
  buildChangeEvidence,
  captureFileState
} from '../tools/change-evidence.mjs';

export function createOrchestrator({
  getTasks,
  saveTasks,
  getConfig,
  toolBrokerFactory,
  modelAdapter,
  modelRouter,
  toolSpec,
  projectRoot,
  emit,
  validateHandoff = validateHandoffPacket,
  store
}) {
  function checkpoint(task, event) {
    const cpData = {
      id: randomUUID(),
      taskId: task.id,
      createdAt: new Date().toISOString(),
      event,
      status: task.status,
      activeModel: task.activeModel,
      step: task.steps.length,
      workspace: projectRoot
    };
    const integrityHash = computeCheckpointHash(cpData);
    const cp = {
      ...cpData,
      integrityHash
    };
    task.checkpoints.push(cp);

    if (store?.recordCheckpoint && !store?.recordTaskTransition) {
      store.recordCheckpoint({
        ...cp,
        taskId: task.id
      });
    }
    // NOTE: checkpoint_created events are emitted in updateTask() ONLY AFTER
    // the SQLite transaction commits successfully — never from checkpoint() directly.
  }

  async function updateTask(task, mutator) {
    const tasks = await getTasks();
    const index = tasks.findIndex(item => item.id === task.id);

    if (index < 0) return;

    const previousStatus = tasks[index].status;
    const checkpointsBefore = tasks[index].checkpoints ? tasks[index].checkpoints.length : 0;

    mutator(tasks[index]);

    assertTransition(
      previousStatus,
      tasks[index].status
    );

    tasks[index].updatedAt = new Date().toISOString();

    const newCheckpoints = tasks[index].checkpoints
      ? tasks[index].checkpoints.slice(checkpointsBefore)
      : [];

    if (store?.recordTaskTransition) {
      // Throws on rollback — events must NOT be emitted if this throws.
      store.recordTaskTransition({
        task: tasks[index],
        previousStatus,
        nextStatus: tasks[index].status,
        reason: tasks[index].message || `Transition to ${tasks[index].status}`,
        checkpoints: newCheckpoints
      });
    } else {
      if (store?.recordCheckpoint) {
        for (const cp of newCheckpoints) {
          store.recordCheckpoint({ ...cp, taskId: tasks[index].id });
        }
      }

      if (store?.recordTaskEvent && previousStatus !== tasks[index].status) {
        store.recordTaskEvent({
          taskId: tasks[index].id,
          previousStatus,
          nextStatus: tasks[index].status,
          timestamp: tasks[index].updatedAt,
          reason: tasks[index].message || `Transition to ${tasks[index].status}`
        });
      }

      if (store?.upsertTask) {
        store.upsertTask(tasks[index]);
      }
    }

    await saveTasks(tasks);

    // Durable-state-before-event: emit ONLY after the persistence path above has
    // succeeded (no exception thrown). A rollback in recordTaskTransition would
    // throw and prevent reaching these lines.
    emit('task', tasks[index]);

    // Emit checkpoint_created for each checkpoint that was persisted in this transition.
    for (const cp of newCheckpoints) {
      emit?.('checkpoint', { taskId: tasks[index].id, checkpoint: cp });
    }
  }

  async function performModelSwitch(current, targetModel, reason, checkpointEvent) {
    const previousModel = current.activeModel || 'previous model';
    let handoffPacket = null;

    await updateTask(current, item => {
      transitionTask(item, 'switching_model');
      handoffPacket = createHandoffPacket(item);

      item.switches.push({
        at: new Date().toISOString(),
        model: targetModel,
        reason,
        handoffPacket
      });

      item.message =
        `Switching from ${previousModel} to ${targetModel}.`;

      checkpoint(
        item,
        checkpointEvent
      );
    });

    emit?.('model_switching', {
      taskId: current.id,
      previousModel,
      targetModel,
      reason
    });

    await updateTask(current, item => {
      transitionTask(item, 'validating_handoff');
      item.message =
        `Validating handoff to ${targetModel}.`;

      checkpoint(
        item,
        `Validating handoff to ${targetModel}`
      );
    });

    const validation = validateHandoff(handoffPacket);

    if (!validation || !validation.valid) {
      const validationErrors = validation?.errors?.length
        ? validation.errors.join('; ')
        : 'Invalid handoff packet';

      await updateTask(current, item => {
        transitionTask(item, 'paused');
        item.message =
          `Handoff validation failed for ${targetModel}: ${validationErrors}`;

        item.steps.push({
          at: new Date().toISOString(),
          kind: 'validation_error',
          model: targetModel,
          detail: validationErrors
        });

        checkpoint(
          item,
          `Handoff validation failed: ${targetModel}`
        );
      });

      return false;
    }

    await updateTask(current, item => {
      transitionTask(item, 'running');
      item.activeModel = targetModel;
      item.message =
        `Handoff validated. Now working with ${targetModel}.`;

      checkpoint(
        item,
        `Handoff validated for ${targetModel}`
      );
    });

    emit?.('model_switched', {
      taskId: current.id,
      previousModel,
      targetModel
    });

    return true;
  }

  const activeRuns = new Map();

  async function pauseTask(taskId) {
    const activeRun = activeRuns.get(taskId);
    if (activeRun) {
      activeRun.controller.abort();
      if (activeRun.promise) {
        try {
          await activeRun.promise;
        } catch {
          // Handled inside runTask
        }
      }
    }

    const tasks = await getTasks();
    const task = tasks.find(item => item.id === taskId);
    if (!task) {
      return { ok: false, error: 'Task not found.', statusCode: 404 };
    }

    if (task.status === 'paused') {
      return { ok: true, status: 'paused', alreadyPaused: !activeRun };
    }

    if (task.status !== 'running' && task.status !== 'queued') {
      return {
        ok: false,
        error: `Cannot pause task with status "${task.status}". Only active tasks may be paused.`,
        statusCode: 400,
        status: task.status
      };
    }

    // Task was queued or not running in runTask yet
    await updateTask(task, item => {
      transitionTask(item, 'paused');
      item.message = 'Task paused before run started.';
      checkpoint(item, 'Task paused');
    });

    return { ok: true, status: 'paused' };
  }

  async function runTask(taskId) {
    const tasks = await getTasks();
    const task = tasks.find(item => item.id === taskId);

    if (!task || task.status === 'running') return;
    if (activeRuns.has(taskId)) return;

    if (store?.recoverTask) {
      const recovery = store.recoverTask(taskId);
      if (!recovery.ok) {
        emit?.('recovery_required', {
          taskId,
          reason: recovery.error || 'Task integrity check failed'
        });
        await updateTask(task, item => {
          // Do not create a new checkpoint when recovery failed. The existing
          // latest checkpoint is the evidence that failed verification and
          // must remain the latest durable checkpoint so resume keeps failing
          // closed until the corruption is manually resolved.
          item.status = 'paused';
          item.message = `Recovery required: ${recovery.error}`;
        });
        return;
      }
    }

    const config = await getConfig();

    const routingRequirements = {
      capabilities: ['text', 'tools'],
      privacyTier: 'local_only'
    };

    const selectedModel = modelRouter?.select({
      ...routingRequirements,
      requireAutomaticFallback: false
    });

    const fallbackModels =
      modelRouter?.getEligibleModels({
        ...routingRequirements,
        requireAutomaticFallback: true
      }) ?? [];

    const models = [
      selectedModel?.modelId,
      ...fallbackModels.map(model => model.modelId),
      ...(selectedModel
        ? []
        : [
            config.preferredModel,
            ...config.fallbacks
          ])
    ].filter(Boolean);

    const uniqueModels = [...new Set(models)];

    if (!uniqueModels.length) {
      await updateTask(task, item => {
        item.status = 'needs_setup';
        item.message =
          'No eligible local Ollama model is available.';
        checkpoint(
          item,
          'No eligible local model configured'
        );
      });

      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;
    let resolveRun;
    const runPromise = new Promise(res => { resolveRun = res; });
    activeRuns.set(taskId, { controller, promise: runPromise });

    async function handleTaskPause(reason = 'Task execution paused by user request.') {
      const currentTasks = await getTasks();
      const current = currentTasks.find(item => item.id === taskId);
      if (!current || current.status === 'paused') return;
      if (current.status !== 'running' && current.status !== 'queued') return;

      await updateTask(current, item => {
        transitionTask(item, 'paused');
        item.message = reason;
        checkpoint(item, 'Task paused');
      });
    }

    try {
      if (signal.aborted) {
        await handleTaskPause('Task paused before run started.');
        return;
      }

      await updateTask(task, item => {
        item.status = 'running';
        item.message =
          'Preparing a local-only agent run.';
        item.activeModel = uniqueModels[0];

        checkpoint(
          item,
          'Run started'
        );
      });

    const active = (await getTasks()).find(
      item => item.id === taskId
    );

    if (!active) return;

    const initialMessages = [
      {
        role: 'system',
        content:
          `You are a careful local software-engineering agent. ` +
          `Work only inside ${projectRoot}. Make small verifiable changes. ` +
          `Never use network access. Available terminal commands: ` +
          `${config.allowedCommands.join(', ')}. ` +
          `Do not claim success without running relevant tests. ` +
          `If a task needs risky/destructive action, explain instead of doing it.`
      },
      {
        role: 'user',
        content: active.goal
      }
    ];

    const MAX_PERSISTED_MESSAGE_BYTES = 200 * 1024;

    const truncateUtf8 = (value, maxBytes) => {
      const bytes = Buffer.from(String(value), 'utf8');
      if (bytes.length <= maxBytes) return String(value);

      const truncated = bytes
        .subarray(0, Math.max(0, maxBytes))
        .toString('utf8');

      return (
        truncated +
        '\n[continuity-agent: content truncated for durable resume]'
      );
    };

    const boundPersistedMessage = message => {
      const encoded = JSON.stringify(message);

      if (
        Buffer.byteLength(encoded, 'utf8') <=
        MAX_PERSISTED_MESSAGE_BYTES
      ) {
        return message;
      }

      if (typeof message.content === 'string') {
        const bounded = {
          ...message,
          content: truncateUtf8(
            message.content,
            MAX_PERSISTED_MESSAGE_BYTES - 1024
          )
        };

        if (
          Buffer.byteLength(JSON.stringify(bounded), 'utf8') <=
          MAX_PERSISTED_MESSAGE_BYTES
        ) {
          return bounded;
        }
      }

      if (Array.isArray(message.tool_calls)) {
        const boundedCalls = message.tool_calls.map(call => {
          const fn = call?.function;

          if (!fn || typeof fn !== 'object') {
            return call;
          }

          const rawArguments =
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {});

          return {
            ...call,
            function: {
              ...fn,
              arguments: truncateUtf8(rawArguments, 24 * 1024)
            }
          };
        });

        const bounded = {
          ...message,
          tool_calls: boundedCalls
        };

        if (
          Buffer.byteLength(JSON.stringify(bounded), 'utf8') <=
          MAX_PERSISTED_MESSAGE_BYTES
        ) {
          return bounded;
        }
      }

      return {
        role: message.role || 'assistant',
        ...(message.tool_call_id
          ? { tool_call_id: message.tool_call_id }
          : {}),
        content:
          '[continuity-agent: message truncated for durable resume]'
      };
    };

    const persistExecutionMessage = message => {
      if (!store?.appendTaskMessage) return;

      store.appendTaskMessage({
        taskId,
        message: boundPersistedMessage(message)
      });
    };

    let messages;

    if (store?.getTaskMessages) {
      const persistedMessages = store.getTaskMessages(taskId);

      if (persistedMessages.length > 0) {
        messages = persistedMessages.map(item => item.message);
      } else {
        messages = [...initialMessages];

        for (const initialMessage of initialMessages) {
          persistExecutionMessage(initialMessage);
        }
      }
    } else {
      messages = [...initialMessages];
    }

    let modelIndex = 0;

    for (
      let step = 0;
      step < config.maxSteps;
      step += 1
    ) {
      if (signal.aborted) {
        await handleTaskPause();
        return;
      }

      const current = (await getTasks()).find(
        item => item.id === taskId
      );

      if (!current || current.status !== 'running') {
        return;
      }

      let reply = null;

      while (
        !reply &&
        modelIndex < uniqueModels.length
      ) {
        if (signal.aborted) {
          await handleTaskPause();
          return;
        }

        const model = uniqueModels[modelIndex];

        const maxRetries = 2;
        let retryAttempt = 0;

        while (!reply) {
          if (signal.aborted) {
            await handleTaskPause();
            return;
          }

          try {
            emit?.('step_started', {
              taskId: current.id,
              step,
              activeModel: model
            });

            reply = await modelAdapter(
              config.endpoint,
              model,
              messages,
              toolSpec,
              { signal }
            );

            if (signal.aborted) {
              await handleTaskPause();
              return;
            }

            if (current.activeModel !== model) {
              const switched = await performModelSwitch(
                current,
                model,
                'Previous local model was unavailable or failed.',
                `Switched to ${model}`
              );

              if (!switched) {
                return;
              }
            }
          } catch (error) {
            if (signal.aborted || error.name === 'AbortError') {
              await handleTaskPause();
              return;
            }

            await updateTask(current, item => {
              item.steps.push({
                at: new Date().toISOString(),
                kind: 'model_error',
                model,
                detail: String(error.message),
                errorType: error.type || 'unknown',
                retryAttempt
              });
            });

            if (
              canRetry(
                error,
                retryAttempt,
                maxRetries
              )
            ) {
              const delayMs = nextRetryDelayMs(
                retryAttempt,
                100,
                5_000
              );

              await updateTask(current, item => {
                item.message =
                  `Retrying ${model} after a transient provider error.`;

                checkpoint(
                  item,
                  `Retry ${retryAttempt + 1} for ${model}`
                );
              });

              await new Promise(resolve => {
                if (signal.aborted) return resolve();
                const timer = setTimeout(resolve, delayMs);
                signal.addEventListener('abort', () => {
                  clearTimeout(timer);
                  resolve();
                }, { once: true });
              });

              if (signal.aborted) {
                await handleTaskPause();
                return;
              }

              retryAttempt += 1;
              continue;
            }

            const canFallback =
              shouldFallbackProviderError(error) &&
              modelIndex + 1 <
                uniqueModels.length;

            if (!canFallback) {
              await updateTask(current, item => {
                item.status = 'paused';

                item.message =
                  `Model ${model} failed and no safe fallback is available. Progress is checkpointed.`;

                checkpoint(
                  item,
                  `Model failure: ${model}`
                );
              });

              return;
            }

            modelIndex += 1;

            const nextModel =
              uniqueModels[modelIndex];

            const switched = await performModelSwitch(
              current,
              nextModel,
              `Fallback after ${model} failed: ${error.message}`,
              `Fallback to ${nextModel}`
            );

            if (!switched) {
              return;
            }

            break;
          }
        }
      }

      if (!reply) {
        await updateTask(current, item => {
          item.status = 'paused';

          item.message =
            'No safe local fallback is available. Progress is checkpointed.';

          checkpoint(
            item,
            'All safe local fallbacks exhausted'
          );
        });

        return;
      }

      const message = reply.message || {};

      if (message.content) {
        const assistantContentMessage = {
          role: 'assistant',
          content: message.content
        };

        messages.push(assistantContentMessage);
        persistExecutionMessage(assistantContentMessage);
      }

      const calls = message.tool_calls || [];

      if (!calls.length) {
        await updateTask(current, item => {
          item.status = 'completed';

          item.message =
            message.content ||
            'The local model completed its run.';

          item.steps.push({
            at: new Date().toISOString(),
            kind: 'assistant',
            model: item.activeModel,
            detail: message.content || ''
          });

          checkpoint(
            item,
            'Run completed'
          );
        });

        return;
      }

      const assistantToolCallMessage = {
        role: 'assistant',
        tool_calls: calls
      };

      messages.push(assistantToolCallMessage);
      persistExecutionMessage(assistantToolCallMessage);

      for (const call of calls) {
        if (signal.aborted) {
          await handleTaskPause();
          return;
        }

        const toolFn = call.function || call;
        const toolName = toolFn.name;
        let toolArgs = toolFn.arguments;
        if (typeof toolArgs === 'string') {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch {
            toolArgs = {};
          }
        }
        toolArgs = toolArgs || {};

        // Check if tool action was already successfully executed (deterministic recovery)
        if (store?.getCompletedToolAction) {
          const completed = store.getCompletedToolAction(taskId, toolName, toolArgs);
          if (completed && completed.resultSummary) {
            let replayedResult;
            try {
              replayedResult = JSON.parse(completed.resultSummary);
            } catch {
              replayedResult = completed.resultSummary;
            }

            const replayedToolMessage = {
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(replayedResult)
            };

            messages.push(replayedToolMessage);
            persistExecutionMessage(replayedToolMessage);

            await updateTask(current, item => {
              item.steps.push({
                at: new Date().toISOString(),
                kind: 'tool',
                name: toolName,
                detail: JSON.stringify(replayedResult).slice(0, 1200),
                replayed: true
              });

              checkpoint(
                item,
                `Tool replayed: ${toolName}`
              );
            });

            continue;
          }
        }

        if (signal.aborted) {
          await handleTaskPause();
          return;
        }

        const toolCall = {
          name: toolName,
          arguments: toolArgs
        };
        const policy = authorizeTool(toolCall, await getConfig());

        if (policy.decision === 'requires_approval') {
          let actionRecord = null;

          if (store?.recordToolAction) {
            actionRecord = store.recordToolAction({
              taskId,
              toolName,
              toolCallId: call.id || null,
              args: toolArgs,
              policyDecision: 'requires_approval',
              status: 'pending',
              startedAt: new Date().toISOString()
            });
          }

          if (!actionRecord || !store?.createApprovalRequest) {
            throw new Error(
              'Approval flow is unavailable; mutation was not executed.'
            );
          }

          let approval = null;

          if (store.getApprovalRequestByToolAction) {
            approval = store.getApprovalRequestByToolAction(
              actionRecord.id
            );
          }

          if (!approval) {
            const expiresAt = new Date(
              Date.now() + 5 * 60 * 1000
            ).toISOString();

            approval = store.createApprovalRequest({
              id: randomUUID(),
              taskId,
              toolActionId: actionRecord.id,
              toolName,
              args: toolArgs,
              expiresAt
            });
          }

          await updateTask(current, item => {
            transitionTask(item, 'awaiting_approval');
            item.message =
              `Approval required for ${toolName}.`;
            item.steps.push({
              at: new Date().toISOString(),
              kind: 'approval_required',
              name: toolName,
              detail: 'A parameter-bound approval request was created.'
            });
            checkpoint(
              item,
              `Approval required: ${toolName}`
            );
          });

          emit?.('approval_required', {
            taskId,
            toolName,
            approvalId: approval.id,
            message: policy.reason ||
              `Approval required for ${toolName}.`
          });

          return;
        }

        let actionRecord = null;
        if (store?.recordToolAction) {
          actionRecord = store.recordToolAction({
            taskId,
            toolName,
            toolCallId: call.id || null,
            args: toolArgs,
            policyDecision: policy.decision,
            status: 'pending',
            startedAt: new Date().toISOString()
          });
        }

        emit?.('tool_started', { taskId, toolName });

        try {
          const broker =
            await toolBrokerFactory();

          // Authentic before-state capture for filesystem mutations: the ACTUAL
          // current file is read through the filesystem broker immediately
          // before the mutation. A missing file is represented explicitly, and
          // sensitive/blocked targets never yield content.
          const evidenceFsBroker = broker?.filesystemBroker;
          const canCaptureEvidence =
            (toolName === 'write_file' || toolName === 'patch_file') &&
            evidenceFsBroker &&
            actionRecord &&
            typeof toolArgs.path === 'string' &&
            toolArgs.path.trim().length > 0;

          const beforeState = canCaptureEvidence
            ? await captureFileState(evidenceFsBroker, toolArgs.path)
            : null;

          const result = await broker.execute(
            call.function || call,
            { signal }
          );

          if (signal.aborted) {
            if (store?.recordToolAction && actionRecord) {
              store.recordToolAction({
                ...actionRecord,
                status: 'failure',
                finishedAt: new Date().toISOString(),
                error: 'Tool execution aborted'
              });
            }
            await handleTaskPause();
            return;
          }

          // Success is recorded atomically together with the change evidence so
          // evidence can never exist for a tool action that is not success, and
          // an evidence persistence failure rolls the success claim back.
          const evidencePathApplicable =
            canCaptureEvidence && !!store?.completeToolActionWithEvidence;

          if (evidencePathApplicable) {
            try {
              const afterState = await captureFileState(
                evidenceFsBroker,
                toolArgs.path
              );

              store.completeToolActionWithEvidence({
                actionRecord,
                resultSummary: JSON.stringify(result).slice(0, 5000),
                evidence: buildChangeEvidence({
                  toolActionId: actionRecord.id,
                  idempotencyKey: actionRecord.idempotencyKey,
                  taskId,
                  toolName,
                  relativePath: toolArgs.path,
                  beforeState,
                  afterState
                })
              });
            } catch (evidenceError) {
              // The filesystem change itself may have happened, but without
              // durable evidence it must not be reported as an attested
              // success. Park the action for verification instead. This branch
              // deliberately does NOT fall through to the plain success
              // recording below.
              if (store?.recordToolAction) {
                store.recordToolAction({
                  ...actionRecord,
                  status: 'needs_verification',
                  finishedAt: new Date().toISOString(),
                  error:
                    'File change evidence could not be persisted: ' +
                    String(evidenceError?.message || evidenceError).slice(0, 500)
                });
              }
            }
          } else if (store?.recordToolAction && actionRecord) {
            store.recordToolAction({
              ...actionRecord,
              status: 'success',
              finishedAt: new Date().toISOString(),
              resultSummary: JSON.stringify(result).slice(0, 5000)
            });
          }

          emit?.('tool_completed', {
            taskId,
            toolName,
            detail: JSON.stringify(result).slice(0, 1200)
          });

          const toolResultMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result)
          };

          messages.push(toolResultMessage);
          persistExecutionMessage(toolResultMessage);

          await updateTask(current, item => {
            item.steps.push({
              at: new Date().toISOString(),
              kind: 'tool',
              name:
                toolName,
              detail:
                JSON.stringify(result).slice(
                  0,
                  1200
                )
            });

            checkpoint(
              item,
              `Tool completed: ${toolName}`
            );
          });
        } catch (error) {
          if (signal.aborted || error.name === 'AbortError') {
            if (store?.recordToolAction && actionRecord) {
              store.recordToolAction({
                ...actionRecord,
                status: 'failure',
                finishedAt: new Date().toISOString(),
                error: 'Tool execution aborted'
              });
            }
            await handleTaskPause();
            return;
          }

          if (store?.recordToolAction && actionRecord) {
            store.recordToolAction({
              ...actionRecord,
              status: 'failure',
              finishedAt: new Date().toISOString(),
              error: String(error.message).slice(0, 1000)
            });
          }

          emit?.('tool_failed', {
            taskId,
            toolName,
            error: String(error.message).slice(0, 1000)
          });

          const toolErrorMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error: String(error.message)
            })
          };

          messages.push(toolErrorMessage);
          persistExecutionMessage(toolErrorMessage);

          await updateTask(current, item => {
            item.steps.push({
              at: new Date().toISOString(),
              kind: 'tool_error',
              name:
                toolName,
              detail:
                String(error.message)
            });

            checkpoint(
              item,
              `Tool denied/failed: ${toolName}`
            );
          });
        }
      }
    }

    const latest = (await getTasks()).find(
      item => item.id === taskId
    );

    if (latest && latest.status === 'running') {
      await updateTask(latest, item => {
        item.status = 'paused';

        item.message =
          'Step limit reached. The project state is checkpointed; continue when ready.';

        checkpoint(
          item,
          'Step limit reached'
        );
      });
    }
  } finally {
    activeRuns.delete(taskId);
    if (resolveRun) resolveRun();
  }
}

  async function executeApprovedAction(request = {}) {
    const isLegacyApprovalId = typeof request === 'string';
    const approvalId = isLegacyApprovalId
      ? request
      : request?.approvalId;
    let taskId = isLegacyApprovalId
      ? null
      : (request?.taskId ?? null);

    if (!store?.getApprovalRequest || !store?.getToolAction) {
      throw new Error('Approved action execution requires the persistent store.');
    }

    if (!approvalId) {
      throw new Error('approvalId is required.');
    }

    const approval = store.getApprovalRequest(approvalId);

    if (!approval) {
      throw new Error('Approval request not found');
    }

    const approvedTaskId = String(approval.taskId);

    if (taskId !== null && String(taskId) !== approvedTaskId) {
      throw new Error('Approval request task binding mismatch');
    }

    taskId = approvedTaskId;

    const action = store.getToolAction(approval.toolActionId);

    if (!action) {
      throw new Error('Approved tool action not found');
    }

    if (action.toolName !== 'write_file' && action.toolName !== 'patch_file') {
      throw new Error(
        `Approved execution is restricted to file mutations; received "${action.toolName}".`
      );
    }

    if (approval.status !== 'approved' && action.status !== 'success') {
      throw new Error(
        `Approval request is not executable with status "${approval.status}".`
      );
    }

    if (String(action.taskId) !== String(taskId)) {
      throw new Error('Tool action task binding mismatch');
    }

    if (String(action.id) !== String(approval.toolActionId)) {
      throw new Error('Tool action identity mismatch');
    }

    if (String(action.toolName) !== String(approval.toolName)) {
      throw new Error('Tool action tool binding mismatch');
    }

    const persistedArgs = action.args || {};

    const persistApprovedToolResult = () => {
      if (!store?.appendTaskMessage) return false;

      // Older durable actions created before tool_call_id existed remain
      // executable. They cannot safely fabricate a model tool-call identity,
      // so transcript persistence is skipped for that legacy record while
      // durable idempotency/recovery remains intact.
      if (!action.toolCallId) return false;

      if (typeof action.resultSummary !== 'string') {
        throw new Error(
          'Approved tool action is missing a durable result summary.'
        );
      }

      store.appendTaskMessage({
        id: `tool-result:${action.id}`,
        taskId,
        message: {
          role: 'tool',
          tool_call_id: action.toolCallId,
          content: action.resultSummary
        }
      });

      return true;
    };

    const resumeApprovedTask = async () => {
      const tasks = await getTasks();
      const currentTask = tasks.find(item => item.id === taskId);

      if (!currentTask || currentTask.status !== 'awaiting_approval') {
        return false;
      }

      await updateTask(currentTask, item => {
        transitionTask(item, 'running');
        item.message =
          `Approval completed for ${action.toolName}. Resuming from the durable transcript.`;
        item.steps.push({
          at: new Date().toISOString(),
          kind: 'approval_completed',
          name: action.toolName,
          detail: 'Approved mutation completed and task is resuming.'
        });
        checkpoint(
          item,
          `Approval completed: ${action.toolName}`
        );
      });

      return true;
    };

    // A previously successful action may only need its still-approved
    // approval request to be consumed. Never execute the broker again.
    if (action.status === 'success') {
      if (approval.status === 'consumed') {
        const resumed = await resumeApprovedTask();

        return {
          ok: true,
          replayed: true,
          resumed,
          approval,
          action,
          result: action.resultSummary
        };
      }

      persistApprovedToolResult();

      const consumed = store.consumeApprovalRequest(approvalId, {
        taskId,
        toolActionId: action.id,
        toolName: action.toolName,
        args: persistedArgs
      });

      const resumed = await resumeApprovedTask();

      return {
        ok: true,
        replayed: true,
        resumed,
        approval: consumed,
        action,
        result: action.resultSummary
      };
    }

    // claimToolActionForApproval performs the authoritative canonical
    // argument-binding check. Do not reconstruct or accept model arguments here.
    const claimedAction = store.claimToolActionForApproval({
      taskId,
      toolActionId: action.id,
      toolName: action.toolName,
      args: persistedArgs
    });

    if (!claimedAction || claimedAction.status !== 'in_progress') {
      throw new Error('Approved tool action was not successfully claimed.');
    }

    const broker = await toolBrokerFactory();

    const isFilesystemMutation =
      action.toolName === 'write_file' ||
      action.toolName === 'patch_file';

    const evidenceFsBroker = broker?.filesystemBroker;

    const canCaptureEvidence =
      isFilesystemMutation &&
      evidenceFsBroker &&
      typeof persistedArgs.path === 'string' &&
      persistedArgs.path.trim().length > 0;

    let beforeState = null;

    if (canCaptureEvidence) {
      beforeState = await captureFileState(
        evidenceFsBroker,
        persistedArgs.path
      );
    }

    const approvedMutationAuthorization =
      async details => {
        if (
          details?.operation === 'write' &&
          action.toolName === 'write_file'
        ) {
          if (
            String(details.path || '') !== String(persistedArgs.path || '') ||
            String(details.content || '') !== String(persistedArgs.content || '')
          ) {
            return {
              approved: false,
              reason: 'Approved write action binding mismatch.'
            };
          }

          return true;
        }

        if (
          details?.operation === 'patch' &&
          action.toolName === 'patch_file'
        ) {
          const persistedPatch = persistedArgs.patch || {
            targetContent: persistedArgs.targetContent,
            replacementContent: persistedArgs.replacementContent
          };

          if (
            String(details.path || '') !== String(persistedArgs.path || '') ||
            JSON.stringify(details.patch ?? {}) !== JSON.stringify(persistedPatch ?? {})
          ) {
            return {
              approved: false,
              reason: 'Approved patch action binding mismatch.'
            };
          }

          return true;
        }

        return {
          approved: false,
          reason: 'Approved mutation operation binding mismatch.'
        };
      };

    try {
      emit?.('tool_started', {
        taskId,
        toolName: action.toolName,
        approved: true,
        approvalId
      });

      const persistedCall = {
        name: action.toolName,
        arguments: persistedArgs
      };

      const brokerCall = {
        ...persistedCall
      };

      Object.defineProperty(brokerCall, 'function', {
        value: {
          ...persistedCall
        },
        enumerable: false,
        configurable: false,
        writable: false
      });

      const result = await broker.execute(
        brokerCall,
        {
          approvedMutationAuthorization
        }
      );

      let evidence = null;

      if (canCaptureEvidence) {
        const afterState = await captureFileState(
          evidenceFsBroker,
          persistedArgs.path
        );

        evidence = buildChangeEvidence({
          toolActionId: claimedAction.id,
          idempotencyKey: claimedAction.idempotencyKey,
          taskId,
          toolName: action.toolName,
          operation:
            action.toolName === 'patch_file' ? 'patch' : 'write',
          relativePath: persistedArgs.path,
          beforeState,
          afterState
        });
      }

      if (store?.completeToolActionWithEvidence) {
        store.completeToolActionWithEvidence({
          actionRecord: claimedAction,
          resultSummary: JSON.stringify(result).slice(0, 12_000),
          evidence
        });
      } else if (store?.recordToolAction) {
        store.recordToolAction({
          ...claimedAction,
          status: 'success',
          finishedAt: new Date().toISOString(),
          resultSummary: JSON.stringify(result).slice(0, 12_000)
        });
      }

      // Persist the exact tool result before approval consumption so a crash
      // cannot leave a consumed approval without its resume transcript.
      if (store?.appendTaskMessage) {
        store.appendTaskMessage({
          id: `tool-result:${action.id}`,
          taskId,
          message: {
            role: 'tool',
            tool_call_id: claimedAction.toolCallId,
            content: JSON.stringify(result)
          }
        });
      }

      const consumed = store.consumeApprovalRequest(approvalId, {
        taskId,
        toolActionId: action.id,
        toolName: action.toolName,
        args: persistedArgs
      });

      const resumed = await resumeApprovedTask();

      emit?.('tool_completed', {
        taskId,
        toolName: action.toolName,
        approvalId,
        result
      });

      return {
        ok: true,
        replayed: false,
        resumed,
        approval: consumed,
        action: store.getToolAction(action.id),
        result
      };
    } catch (error) {
      // If the mutation may already have happened, do not convert the action
      // back into pending or retry it automatically. Existing recovery rules
      // will park unfinished actions for verification.
      if (store?.recordToolAction && claimedAction) {
        try {
          const currentAction = store.getToolAction(claimedAction.id);

          // Only an action that is still in_progress is uncertain about
          // whether physical execution completed. A success record is already
          // durable evidence and must never be downgraded.
          if (currentAction?.status === 'in_progress') {
            store.recordToolAction({
              ...currentAction,
              status: 'needs_verification',
              finishedAt: new Date().toISOString(),
              error: String(error.message).slice(0, 2000)
            });
          }
        } catch {
          // Preserve the original execution error.
        }
      }

      emit?.('tool_failed', {
        taskId,
        toolName: action.toolName,
        approvalId,
        error: String(error.message).slice(0, 1000)
      });

      throw error;
    }
  }

  return {
    checkpoint,
    updateTask,
    runTask,
    pauseTask,
    executeApprovedAction
  };
}