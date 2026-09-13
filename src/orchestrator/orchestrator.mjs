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
          item.status = 'paused';
          item.message = `Recovery required: ${recovery.error}`;
          checkpoint(item, `Recovery required: ${recovery.error}`);
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

    const messages = [
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
        messages.push({
          role: 'assistant',
          content: message.content
        });
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

      messages.push({
        role: 'assistant',
        tool_calls: calls
      });

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

            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(replayedResult)
            });

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

        let actionRecord = null;
        if (store?.recordToolAction) {
          actionRecord = store.recordToolAction({
            taskId,
            toolName,
            args: toolArgs,
            policyDecision: 'allowed',
            status: 'pending',
            startedAt: new Date().toISOString()
          });
        }

        emit?.('tool_started', { taskId, toolName });

        try {
          const broker =
            await toolBrokerFactory();

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

          if (store?.recordToolAction && actionRecord) {
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

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result)
          });

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

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error: String(error.message)
            })
          });

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

  return {
    checkpoint,
    updateTask,
    runTask,
    pauseTask
  };
}