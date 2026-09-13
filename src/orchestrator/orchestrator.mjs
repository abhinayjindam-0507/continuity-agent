import { randomUUID } from 'node:crypto';
import { assertTransition } from '../task-state.mjs';

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

    // Lifecycle validation remains the existing authority.
    assertTransition(previousStatus, tasks[index].status);

    tasks[index].updatedAt = new Date().toISOString();
    await saveTasks(tasks);
    emit('task', tasks[index]);
  }

  async function runTask(taskId) {
    const tasks = await getTasks();
    const task = tasks.find(item => item.id === taskId);

    if (!task || task.status === 'running') return;

    const config = await getConfig();

    const selectedModel = modelRouter?.select({
      capabilities: ['text', 'tools'],
      privacyTier: 'local_only',
      requireAutomaticFallback: false
    });

    const models = selectedModel
      ? [selectedModel.modelId]
      : [config.preferredModel, ...config.fallbacks].filter(Boolean);

    if (!models.length) {
      await updateTask(task, item => {
        item.status = 'needs_setup';
        item.message = 'No eligible local Ollama model is available.';
        checkpoint(item, 'No eligible local model configured');
      });
      return;
    }

    await updateTask(task, item => {
      item.status = 'running';
      item.message = 'Preparing a local-only agent run.';
      item.activeModel = models[0];
      checkpoint(item, 'Run started');
    });

    const active = (await getTasks()).find(item => item.id === taskId);

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
      { role: 'user', content: active.goal }
    ];

    let modelIndex = 0;

    for (let step = 0; step < config.maxSteps; step += 1) {
      const current = (await getTasks()).find(item => item.id === taskId);

      if (!current || current.status !== 'running') return;

      let reply;

      while (!reply && modelIndex < models.length) {
        const model = models[modelIndex];

        try {
          reply = await modelAdapter(config.endpoint, model, messages, toolSpec);

          if (current.activeModel !== model) {
            await updateTask(current, item => {
              item.activeModel = model;
              item.switches.push({
                at: new Date().toISOString(),
                model,
                reason: 'Previous local model was unavailable or failed.'
              });
              item.message = `Now working with ${model}.`;
              checkpoint(item, `Switched to ${model}`);
            });
          }
        } catch (error) {
          modelIndex += 1;

          await updateTask(current, item => {
            item.steps.push({
              at: new Date().toISOString(),
              kind: 'model_error',
              model,
              detail: String(error.message)
            });
          });
        }
      }

      if (!reply) {
        await updateTask(current, item => {
          item.status = 'paused';
          item.message =
            'All configured local models were unavailable. Progress is checkpointed.';
          checkpoint(item, 'All local fallbacks unavailable');
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
            message.content || 'The local model completed its run.';
          item.steps.push({
            at: new Date().toISOString(),
            kind: 'assistant',
            model: item.activeModel,
            detail: message.content || ''
          });
          checkpoint(item, 'Run completed');
        });
        return;
      }

      messages.push({
        role: 'assistant',
        tool_calls: calls
      });

      for (const call of calls) {
        try {
          const broker = await toolBrokerFactory();
          const result = await broker.execute(call.function || call);

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result)
          });

          await updateTask(current, item => {
            item.steps.push({
              at: new Date().toISOString(),
              kind: 'tool',
              name: (call.function || call).name,
              detail: JSON.stringify(result).slice(0, 1200)
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
              name: (call.function || call).name,
              detail: String(error.message)
            });

            checkpoint(
              item,
              `Tool denied/failed: ${(call.function || call).name}`
            );
          });
        }
      }
    }

    const latest = (await getTasks()).find(item => item.id === taskId);

    if (latest) {
      await updateTask(latest, item => {
        item.status = 'paused';
        item.message =
          'Step limit reached. The project state is checkpointed; continue when ready.';
        checkpoint(item, 'Step limit reached');
      });
    }
  }

  return {
    checkpoint,
    updateTask,
    runTask
  };
}