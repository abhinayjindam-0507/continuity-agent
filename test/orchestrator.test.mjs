import assert from 'node:assert/strict';
import test from 'node:test';

import { createOrchestrator } from '../src/orchestrator/orchestrator.mjs';

test('orchestrator starts a task with the configured local model', async () => {
  const tasks = [
    {
      id: 'task-1',
      goal: 'Check the project',
      status: 'queued',
      message: 'Waiting to start.',
      activeModel: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    }
  ];

  const savedEvents = [];
  const emitted = [];

  const orchestrator = createOrchestrator({
    getTasks: async () => tasks,
    saveTasks: async (nextTasks) => {
      tasks.splice(0, tasks.length, ...nextTasks);
      savedEvents.push(nextTasks[0]);
    },
    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel: 'qwen3:4b',
      fallbacks: [],
      maxSteps: 1,
      allowedCommands: [],
      networkToolsEnabled: false,
      allowWrites: false
    }),
    toolBrokerFactory: async () => ({
      execute: async () => ({ ok: true })
    }),
    modelAdapter: async (endpoint, model, messages) => {
      assert.equal(endpoint, 'http://127.0.0.1:11434');
      assert.equal(model, 'qwen3:4b');
      assert.equal(messages.at(-1).role, 'user');
      assert.equal(messages.at(-1).content, 'Check the project');

      return {
        message: {
          content: 'Project checked.',
          tool_calls: []
        }
      };
    },
    toolSpec: [],
    projectRoot: '/tmp/test-project',
    emit: (type, payload) => {
      emitted.push({ type, payload });
    }
  });

  await orchestrator.runTask('task-1');

  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].activeModel, 'qwen3:4b');
  assert.equal(tasks[0].message, 'Project checked.');
  assert.ok(tasks[0].checkpoints.length >= 2);
  assert.ok(savedEvents.length >= 2);
  assert.ok(emitted.length >= 2);
});

test('orchestrator selects the model through the model router', async () => {
  const tasks = [
    {
      id: 'task-router-1',
      goal: 'Use the routed model',
      status: 'queued',
      message: 'Waiting to start.',
      activeModel: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: []
    }
  ];

  let routerSelections = 0;

  const orchestrator = createOrchestrator({
    getTasks: async () => tasks,
    saveTasks: async (nextTasks) => {
      tasks.splice(0, tasks.length, ...nextTasks);
    },
    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel: 'wrong-model',
      fallbacks: ['also-wrong'],
      maxSteps: 1,
      allowedCommands: [],
      networkToolsEnabled: false,
      allowWrites: false
    }),
    toolBrokerFactory: async () => ({
      execute: async () => ({ ok: true })
    }),
    modelRouter: {
      select: (requirements) => {
        routerSelections += 1;

        assert.deepEqual(requirements, {
          capabilities: ['text', 'tools'],
          privacyTier: 'local_only',
          requireAutomaticFallback: false
        });

        return {
          provider: 'ollama',
          modelId: 'qwen3:4b',
          version: 'qwen3:4b',
          capabilities: ['text', 'tools'],
          contextLimit: 262144,
          privacyTier: 'local_only',
          health: 'healthy',
          routingClass: 'support_only',
          automaticFallbackAllowed: false
        };
      }
    },
    modelAdapter: async (endpoint, model, messages) => {
      assert.equal(model, 'qwen3:4b');
      assert.equal(messages.at(-1).content, 'Use the routed model');

      return {
        message: {
          content: 'Routed model completed the task.',
          tool_calls: []
        }
      };
    },
    toolSpec: [],
    projectRoot: '/tmp/test-project',
    emit: () => {}
  });

  await orchestrator.runTask('task-router-1');

  assert.equal(routerSelections, 1);
  assert.equal(tasks[0].activeModel, 'qwen3:4b');
  assert.equal(tasks[0].status, 'completed');
});