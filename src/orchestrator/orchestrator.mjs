import { randomUUID } from 'node:crypto';
import { assertTransition } from '../task-state.mjs';
import { shouldFallbackProviderError } from '../router/fallback-policy.mjs';
import {
  canRetry,
  nextRetryDelayMs
} from '../router/retry-policy.mjs';
import { createHandoffPacket } from './handoff.mjs';

export function createOrchestrator({
  getTasks,
  saveTasks,
  getConfig,
  toolBrokerFactory,
  modelAdapter,
  modelRouter,
  toolSpec,
  projectRoot,
  emit
}) {
  function checkpoint(task, event) {
    task.checkpoints.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      event,
      status: task.status,
      activeModel: task.activeModel,
      step: task.steps.length,
      workspace: projectRoot
    });
  }

  async function updateTask(task, mutator) {
    const tasks = await getTasks();
    const index = tasks.findIndex(item => item.id === task.id);

    if (index < 0) return;

    const previousStatus = tasks[index].status;

    mutator(tasks[index]);

    assertTransition(
      previousStatus,
      tasks[index].status
    );

    tasks[index].updatedAt = new Date().toISOString();

    await saveTasks(tasks);
    emit('task', tasks[index]);
  }

  async function runTask(taskId) {
    const tasks = await getTasks();
    const task = tasks.find(item => item.id === taskId);

    if (!task || task.status === 'running') return;

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
        const model = uniqueModels[modelIndex];

        const maxRetries = 2;
        let retryAttempt = 0;

        while (!reply) {
          try {
            reply = await modelAdapter(
              config.endpoint,
              model,
              messages,
              toolSpec
            );

            if (current.activeModel !== model) {
              await updateTask(current, item => {
                const handoffPacket = createHandoffPacket(item);

                item.activeModel = model;

                item.switches.push({
                  at: new Date().toISOString(),
                  model,
                  reason:
                    'Previous local model was unavailable or failed.',
                  handoffPacket
                });

                item.message =
                  `Now working with ${model}.`;

                checkpoint(
                  item,
                  `Switched to ${model}`
                );
              });
            }
          } catch (error) {
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
                setTimeout(resolve, delayMs);
              });

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

            await updateTask(current, item => {
                const handoffPacket = createHandoffPacket(item);

                item.activeModel = nextModel;

                item.switches.push({
                  at: new Date().toISOString(),
                  model: nextModel,
                  reason:
                    `Fallback after ${model} failed: ${error.message}`,
                  handoffPacket
                });

                item.message =
                  `Switching from ${model} to ${nextModel}.`;

                checkpoint(
                  item,
                  `Fallback to ${nextModel}`
                );
              });

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
        try {
          const broker =
            await toolBrokerFactory();

          const result = await broker.execute(
            call.function || call
          );

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
                (call.function || call).name,
              detail:
                JSON.stringify(result).slice(
                  0,
                  1200
                )
            });

            checkpoint(
              item,
              `Tool completed: ${(call.function || call).name}`
            );
          });
        } catch (error) {
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
                (call.function || call).name,
              detail:
                String(error.message)
            });

            checkpoint(
              item,
              `Tool denied/failed: ${(call.function || call).name}`
            );
          });
        }
      }
    }

    const latest = (await getTasks()).find(
      item => item.id === taskId
    );

    if (latest) {
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
  }

  return {
    checkpoint,
    updateTask,
    runTask
  };
}