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
    saveTasks: async nextTasks => {
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
    saveTasks: async nextTasks => {
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
      getEligibleModels: requirements => {
        assert.deepEqual(requirements, {
          capabilities: ['text', 'tools'],
          privacyTier: 'local_only',
          requireAutomaticFallback: true
        });

        return [];
      },

      select: requirements => {
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
      assert.equal(endpoint, 'http://127.0.0.1:11434');
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

test('orchestrator falls back when the selected model is unavailable', async () => {
  const tasks = [
    {
      id: 'task-fallback-1',
      goal: 'Continue using the fallback model',
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

  const attemptedModels = [];

  const orchestrator = createOrchestrator({
    getTasks: async () => tasks,

    saveTasks: async nextTasks => {
      tasks.splice(0, tasks.length, ...nextTasks);
    },

    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel: '',
      fallbacks: [],
      maxSteps: 1,
      allowedCommands: [],
      networkToolsEnabled: false,
      allowWrites: false
    }),

    toolBrokerFactory: async () => ({
      execute: async () => ({ ok: true })
    }),

    modelRouter: {
      getEligibleModels: requirements => {
        assert.deepEqual(requirements, {
          capabilities: ['text', 'tools'],
          privacyTier: 'local_only',
          requireAutomaticFallback: true
        });

        return [
          {
            provider: 'ollama',
            modelId: 'primary-model',
            version: 'primary-model',
            capabilities: ['text', 'tools'],
            contextLimit: 32768,
            privacyTier: 'local_only',
            health: 'healthy',
            routingClass: 'support_only',
            automaticFallbackAllowed: true
          },
          {
            provider: 'ollama',
            modelId: 'fallback-model',
            version: 'fallback-model',
            capabilities: ['text', 'tools'],
            contextLimit: 32768,
            privacyTier: 'local_only',
            health: 'healthy',
            routingClass: 'fallback',
            automaticFallbackAllowed: true
          }
        ];
      },

      select: requirements => {
        assert.deepEqual(requirements, {
          capabilities: ['text', 'tools'],
          privacyTier: 'local_only',
          requireAutomaticFallback: false
        });

        return {
          provider: 'ollama',
          modelId: 'primary-model',
          version: 'primary-model',
          capabilities: ['text', 'tools'],
          contextLimit: 32768,
          privacyTier: 'local_only',
          health: 'healthy',
          routingClass: 'support_only',
          automaticFallbackAllowed: true
        };
      }
    },

    modelAdapter: async (_endpoint, model) => {
      attemptedModels.push(model);

      if (model === 'primary-model') {
        const error = new Error('model unavailable');
        error.type = 'unavailable';
        throw error;
      }

      return {
        message: {
          content: 'Fallback model completed the task.',
          tool_calls: []
        }
      };
    },

    toolSpec: [],
    projectRoot: '/tmp/test-project',
    emit: () => {}
  });

  await orchestrator.runTask('task-fallback-1');

  assert.deepEqual(
    attemptedModels,
    ['primary-model', 'fallback-model']
  );

  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].activeModel, 'fallback-model');
  assert.equal(tasks[0].switches.length, 1);
});
test('orchestrator retries a transient provider error before fallback', async () => {
  const tasks = [
    {
      id: 'task-retry-1',
      goal: 'Retry the transient failure',
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

  let attempts = 0;

  const orchestrator = createOrchestrator({
    getTasks: async () => tasks,

    saveTasks: async nextTasks => {
      tasks.splice(0, tasks.length, ...nextTasks);
    },

    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel: '',
      fallbacks: [],
      maxSteps: 1,
      allowedCommands: [],
      networkToolsEnabled: false,
      allowWrites: false
    }),

    toolBrokerFactory: async () => ({
      execute: async () => ({ ok: true })
    }),

    modelRouter: {
      getEligibleModels: () => [],
      select: () => ({
        provider: 'ollama',
        modelId: 'primary-model',
        version: 'primary-model',
        capabilities: ['text', 'tools'],
        contextLimit: 32768,
        privacyTier: 'local_only',
        health: 'healthy',
        routingClass: 'support_only',
        automaticFallbackAllowed: false
      })
    },

    modelAdapter: async () => {
      attempts += 1;

      if (attempts === 1) {
        const error = new Error('temporary failure');
        error.type = 'transient';
        error.retryable = true;
        throw error;
      }

      return {
        message: {
          content: 'Succeeded after retry.',
          tool_calls: []
        }
      };
    },

    toolSpec: [],
    projectRoot: '/tmp/test-project',
    emit: () => {}
  });

  await orchestrator.runTask('task-retry-1');

  assert.equal(attempts, 2);
  assert.equal(tasks[0].status, 'completed');
  assert.equal(
    tasks[0].activeModel,
    'primary-model'
  );
});

test('fallback model switch records a bounded handoff packet', async () => {
  const tasks = [
    {
      id: 'task-handoff-1',
      goal: 'Test handoff packet on fallback switch',
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

  const orchestrator = createOrchestrator({
    getTasks: async () => tasks,

    saveTasks: async nextTasks => {
      tasks.splice(0, tasks.length, ...nextTasks);
    },

    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel: '',
      fallbacks: [],
      maxSteps: 1,
      allowedCommands: ['npm'],
      networkToolsEnabled: false,
      allowWrites: false
    }),

    toolBrokerFactory: async () => ({
      execute: async () => ({ ok: true })
    }),

    modelRouter: {
      getEligibleModels: () => [
        {
          provider: 'ollama',
          modelId: 'model-a',
          capabilities: ['text', 'tools'],
          contextLimit: 32768,
          privacyTier: 'local_only',
          health: 'healthy',
          routingClass: 'support_only',
          automaticFallbackAllowed: true
        },
        {
          provider: 'ollama',
          modelId: 'model-b',
          capabilities: ['text', 'tools'],
          contextLimit: 32768,
          privacyTier: 'local_only',
          health: 'healthy',
          routingClass: 'fallback',
          automaticFallbackAllowed: true
        }
      ],
      select: () => ({
        provider: 'ollama',
        modelId: 'model-a',
        capabilities: ['text', 'tools'],
        contextLimit: 32768,
        privacyTier: 'local_only',
        health: 'healthy',
        routingClass: 'support_only',
        automaticFallbackAllowed: true
      })
    },

    modelAdapter: async (_endpoint, model) => {
      if (model === 'model-a') {
        const error = new Error('model unavailable');
        error.type = 'unavailable';
        throw error;
      }
      return {
        message: {
          content: 'Fallback completed.',
          tool_calls: []
        }
      };
    },

    toolSpec: [],
    projectRoot: '/tmp/test-project',
    emit: () => {}
  });

  await orchestrator.runTask('task-handoff-1');

  // Existing fallback behavior still works
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].activeModel, 'model-b');
  assert.equal(tasks[0].switches.length, 1);

  // The switch record contains a handoff packet
  const sw = tasks[0].switches[0];
  assert.ok(sw.handoffPacket, 'switch must contain a handoffPacket');

  const hp = sw.handoffPacket;

  // Bounded continuity fields are present
  assert.equal(hp.taskId, 'task-handoff-1');
  assert.equal(hp.originalGoal, 'Test handoff packet on fallback switch');
  assert.equal(typeof hp.currentStatus, 'string');
  assert.equal(typeof hp.activeModel, 'string');
  assert.equal(typeof hp.currentStepNumber, 'number');
  assert.ok(Array.isArray(hp.recentSteps));
  assert.ok(Array.isArray(hp.recentCheckpoints));
  assert.ok(Array.isArray(hp.recentModelSwitches));
  assert.ok(Array.isArray(hp.recentErrors));
  assert.ok(hp.resumeContext && typeof hp.resumeContext === 'object');
  assert.equal(typeof hp.resumeContext.canResume, 'boolean');
  assert.equal(typeof hp.resumeContext.recommendedAction, 'string');
});

test('handoff packet contains expected bounded fields and no sensitive data', async () => {
  const tasks = [
    {
      id: 'task-handoff-sec',
      goal: 'Verify handoff packet security on switch',
      status: 'queued',
      message: 'Waiting to start.',
      activeModel: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      checkpoints: [],
      switches: [],
      // Sensitive fields that must NOT appear in the handoff packet
      apiKey: 'sk-secret-key-12345',
      credentials: { user: 'admin', password: 'secret' },
      secret: 'top-secret',
      token: 'jwt.token.value',
      env: { API_SECRET: 'env-secret' },
      conversation: [{ role: 'system', content: 'hidden' }],
      fileContents: 'raw file dump'
    }
  ];

  const orchestrator = createOrchestrator({
    getTasks: async () => tasks,

    saveTasks: async nextTasks => {
      tasks.splice(0, tasks.length, ...nextTasks);
    },

    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel: '',
      fallbacks: [],
      maxSteps: 1,
      allowedCommands: [],
      networkToolsEnabled: false,
      allowWrites: false
    }),

    toolBrokerFactory: async () => ({
      execute: async () => ({ ok: true })
    }),

    modelRouter: {
      getEligibleModels: () => [
        {
          provider: 'ollama',
          modelId: 'secure-model-a',
          capabilities: ['text', 'tools'],
          contextLimit: 32768,
          privacyTier: 'local_only',
          health: 'healthy',
          routingClass: 'support_only',
          automaticFallbackAllowed: true
        },
        {
          provider: 'ollama',
          modelId: 'secure-model-b',
          capabilities: ['text', 'tools'],
          contextLimit: 32768,
          privacyTier: 'local_only',
          health: 'healthy',
          routingClass: 'fallback',
          automaticFallbackAllowed: true
        }
      ],
      select: () => ({
        provider: 'ollama',
        modelId: 'secure-model-a',
        capabilities: ['text', 'tools'],
        contextLimit: 32768,
        privacyTier: 'local_only',
        health: 'healthy',
        routingClass: 'support_only',
        automaticFallbackAllowed: true
      })
    },

    modelAdapter: async (_endpoint, model) => {
      if (model === 'secure-model-a') {
        const error = new Error('unavailable');
        error.type = 'unavailable';
        throw error;
      }
      return {
        message: {
          content: 'Done.',
          tool_calls: []
        }
      };
    },

    toolSpec: [],
    projectRoot: '/tmp/test-project',
    emit: () => {}
  });

  await orchestrator.runTask('task-handoff-sec');

  const hp = tasks[0].switches[0].handoffPacket;
  assert.ok(hp);

  // Sensitive fields must not be present
  assert.equal(hp.apiKey, undefined);
  assert.equal(hp.credentials, undefined);
  assert.equal(hp.secret, undefined);
  assert.equal(hp.token, undefined);
  assert.equal(hp.env, undefined);
  assert.equal(hp.conversation, undefined);
  assert.equal(hp.fileContents, undefined);

  // The packet must not contain arbitrary task properties
  const packetKeys = new Set(Object.keys(hp));
  assert.ok(!packetKeys.has('apiKey'));
  assert.ok(!packetKeys.has('credentials'));
  assert.ok(!packetKeys.has('secret'));
  assert.ok(!packetKeys.has('token'));
  assert.ok(!packetKeys.has('env'));
  assert.ok(!packetKeys.has('conversation'));
  assert.ok(!packetKeys.has('fileContents'));

  // Bounded continuity fields are still present
  assert.equal(hp.taskId, 'task-handoff-sec');
  assert.equal(hp.originalGoal, 'Verify handoff packet security on switch');
  assert.ok(hp.resumeContext);
});