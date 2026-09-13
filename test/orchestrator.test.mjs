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

// --- Local test helpers for model switching and handoff validation ---

function createTestTask(id, goal = 'Test task') {
  return {
    id,
    goal,
    status: 'queued',
    message: 'Waiting to start.',
    activeModel: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    checkpoints: [],
    switches: []
  };
}

function createTwoModelRouter(primaryModel, fallbackModel) {
  const primary = {
    provider: 'ollama',
    modelId: primaryModel,
    capabilities: ['text', 'tools'],
    contextLimit: 32768,
    privacyTier: 'local_only',
    health: 'healthy',
    routingClass: 'support_only',
    automaticFallbackAllowed: true
  };
  const fallback = {
    provider: 'ollama',
    modelId: fallbackModel,
    capabilities: ['text', 'tools'],
    contextLimit: 32768,
    privacyTier: 'local_only',
    health: 'healthy',
    routingClass: 'fallback',
    automaticFallbackAllowed: true
  };
  return {
    getEligibleModels: () => [primary, fallback],
    select: () => primary
  };
}

function createFallbackModelAdapter(failModel, replyContent = 'Done.', onCall) {
  return async (_endpoint, model) => {
    onCall?.(model);
    if (model === failModel) {
      const error = new Error(`${failModel} unavailable`);
      error.type = 'unavailable';
      throw error;
    }
    return {
      message: {
        content: replyContent,
        tool_calls: []
      }
    };
  };
}

function createTestOrchestrator({
  tasks,
  onSave,
  preferredModel = '',
  modelRouter,
  modelAdapter,
  validateHandoff
}) {
  return createOrchestrator({
    getTasks: async () => tasks,
    saveTasks: async nextTasks => {
      tasks.splice(0, tasks.length, ...nextTasks);
      onSave?.(nextTasks);
    },
    getConfig: async () => ({
      provider: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      preferredModel,
      fallbacks: [],
      maxSteps: 1,
      allowedCommands: [],
      networkToolsEnabled: false,
      allowWrites: false
    }),
    toolBrokerFactory: async () => ({
      execute: async () => ({ ok: true })
    }),
    modelRouter,
    modelAdapter,
    toolSpec: [],
    projectRoot: '/tmp/test-project',
    emit: () => {},
    ...(validateHandoff !== undefined ? { validateHandoff } : {})
  });
}

test('successful model switch enters validating_handoff before running', async () => {
  const tasks = [createTestTask('task-switch-lifecycle', 'Test switching lifecycle transitions')];
  const statusHistory = [];

  const orchestrator = createTestOrchestrator({
    tasks,
    onSave: nextTasks => statusHistory.push(nextTasks[0].status),
    modelRouter: createTwoModelRouter('model-1', 'model-2'),
    modelAdapter: createFallbackModelAdapter('model-1', 'Model 2 succeeded.')
  });

  await orchestrator.runTask('task-switch-lifecycle');

  // Verify full status sequence during model switch:
  // starts at running -> switching_model -> validating_handoff -> running -> completed
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].activeModel, 'model-2');

  const switchIndex = statusHistory.indexOf('switching_model');
  const validatingIndex = statusHistory.indexOf('validating_handoff');
  const runningAfterValidatingIndex = statusHistory.indexOf('running', validatingIndex);

  assert.ok(switchIndex >= 0, 'Must transition to switching_model');
  assert.ok(validatingIndex > switchIndex, 'Must transition to validating_handoff after switching_model');
  assert.ok(runningAfterValidatingIndex > validatingIndex, 'Must transition to running after validating_handoff');

  // Verify checkpoints recorded during validating_handoff
  const validatingCheckpoint = tasks[0].checkpoints.find(
    cp => cp.status === 'validating_handoff'
  );
  assert.ok(validatingCheckpoint, 'Must record a checkpoint in validating_handoff status');
  assert.equal(validatingCheckpoint.event, 'Validating handoff to model-2');

  const validatedCheckpoint = tasks[0].checkpoints.find(
    cp => cp.event === 'Handoff validated for model-2'
  );
  assert.ok(validatedCheckpoint, 'Must record a checkpoint when handoff is validated');
  assert.equal(validatedCheckpoint.status, 'running');
});

test('failed validation pauses instead of resuming', async () => {
  const tasks = [createTestTask('task-switch-fail', 'Test failed validation pauses execution')];
  const attemptedModels = [];

  const orchestrator = createTestOrchestrator({
    tasks,
    modelRouter: createTwoModelRouter('model-primary', 'model-fallback'),
    modelAdapter: createFallbackModelAdapter('model-primary', 'Should not run if validation fails.', model => {
      attemptedModels.push(model);
    }),
    validateHandoff: () => ({
      valid: false,
      errors: ['Simulated corrupted handoff packet'],
      warnings: []
    })
  });

  await orchestrator.runTask('task-switch-fail');

  // Execution must NOT have resumed with model-fallback
  assert.deepEqual(attemptedModels, ['model-primary']);

  // Task must be in paused state
  assert.equal(tasks[0].status, 'paused');
  assert.ok(tasks[0].message.includes('Handoff validation failed for model-fallback'));
  assert.ok(tasks[0].message.includes('Simulated corrupted handoff packet'));

  // Validation failure recorded in steps
  const errorStep = tasks[0].steps.find(s => s.kind === 'validation_error');
  assert.ok(errorStep, 'Must record validation_error step');
  assert.equal(errorStep.model, 'model-fallback');
  assert.equal(errorStep.detail, 'Simulated corrupted handoff packet');

  // Validation failure recorded in checkpoints
  const failCheckpoint = tasks[0].checkpoints.find(
    cp => cp.event === 'Handoff validation failed: model-fallback'
  );
  assert.ok(failCheckpoint, 'Must record failure checkpoint');
  assert.equal(failCheckpoint.status, 'paused');
});

test('successful-reply model switch enters validating_handoff before completing', async () => {
  const tasks = [createTestTask('task-reply-switch', 'Test successful reply model switch validation')];
  const statusHistory = [];

  const orchestrator = createTestOrchestrator({
    tasks,
    onSave: nextTasks => statusHistory.push(nextTasks[0].status),
    preferredModel: 'model-reply-b',
    modelAdapter: async () => {
      tasks[0].activeModel = 'model-reply-a';
      return {
        message: {
          content: 'Reply with model switch.',
          tool_calls: []
        }
      };
    }
  });

  await orchestrator.runTask('task-reply-switch');

  // Should transition: running -> switching_model -> validating_handoff -> running -> completed
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].activeModel, 'model-reply-b');
  assert.equal(tasks[0].switches.length, 1);

  const switchRecord = tasks[0].switches[0];
  assert.equal(switchRecord.model, 'model-reply-b');
  assert.ok(switchRecord.handoffPacket, 'Must attach handoffPacket to switch record');

  const switchIndex = statusHistory.indexOf('switching_model');
  const validatingIndex = statusHistory.indexOf('validating_handoff');
  const runningAfterValidatingIndex = statusHistory.indexOf('running', validatingIndex);

  assert.ok(switchIndex >= 0, 'Must transition through switching_model');
  assert.ok(validatingIndex > switchIndex, 'Must transition to validating_handoff after switching_model');
  assert.ok(runningAfterValidatingIndex > validatingIndex, 'Must transition to running after validating_handoff');

  const validatingCheckpoint = tasks[0].checkpoints.find(
    cp => cp.status === 'validating_handoff'
  );
  assert.ok(validatingCheckpoint, 'Must record checkpoint in validating_handoff');

  const validatedCheckpoint = tasks[0].checkpoints.find(
    cp => cp.event === 'Handoff validated for model-reply-b'
  );
  assert.ok(validatedCheckpoint, 'Must record checkpoint when handoff is validated');
});

test('successful-reply model switch with failed validation pauses instead of completing', async () => {
  const tasks = [createTestTask('task-reply-switch-fail', 'Test successful reply model switch validation failure')];

  const orchestrator = createTestOrchestrator({
    tasks,
    preferredModel: 'model-reply-b',
    modelAdapter: async () => {
      tasks[0].activeModel = 'model-reply-a';
      return {
        message: {
          content: 'This should not be processed if validation fails.',
          tool_calls: []
        }
      };
    },
    validateHandoff: () => ({
      valid: false,
      errors: ['Simulated structural error on reply switch'],
      warnings: []
    })
  });

  await orchestrator.runTask('task-reply-switch-fail');

  // Must pause and NOT complete
  assert.equal(tasks[0].status, 'paused');
  assert.ok(tasks[0].message.includes('Handoff validation failed for model-reply-b'));
  assert.ok(tasks[0].message.includes('Simulated structural error on reply switch'));

  const errorStep = tasks[0].steps.find(s => s.kind === 'validation_error');
  assert.ok(errorStep, 'Must record validation_error step');
  assert.equal(errorStep.model, 'model-reply-b');
  assert.equal(errorStep.detail, 'Simulated structural error on reply switch');

  const failCheckpoint = tasks[0].checkpoints.find(
    cp => cp.event === 'Handoff validation failed: model-reply-b'
  );
  assert.ok(failCheckpoint, 'Must record failure checkpoint');
  assert.equal(failCheckpoint.status, 'paused');
});

test('handoff packet captures previous active model, not target model', async () => {
  const tasks = [createTestTask('task-prev-model', 'Test handoff packet captures previous model')];

  const orchestrator = createTestOrchestrator({
    tasks,
    modelRouter: createTwoModelRouter('original-model', 'target-model'),
    modelAdapter: createFallbackModelAdapter('original-model')
  });

  await orchestrator.runTask('task-prev-model');

  const hp = tasks[0].switches[0].handoffPacket;
  assert.ok(hp, 'Must have a handoff packet');
  // The handoff packet must capture the model BEFORE the switch, not the target
  assert.equal(hp.activeModel, 'original-model',
    'Handoff packet must contain the previous active model, not the target');
});

test('activeModel remains unchanged during switching_model and validating_handoff', async () => {
  const tasks = [createTestTask('task-deferred-model', 'Test activeModel is deferred until validation passes')];
  const modelDuringSwitching = [];
  const modelDuringValidating = [];

  const orchestrator = createTestOrchestrator({
    tasks,
    onSave: nextTasks => {
      if (nextTasks[0].status === 'switching_model') {
        modelDuringSwitching.push(nextTasks[0].activeModel);
      }
      if (nextTasks[0].status === 'validating_handoff') {
        modelDuringValidating.push(nextTasks[0].activeModel);
      }
    },
    modelRouter: createTwoModelRouter('old-model', 'new-model'),
    modelAdapter: createFallbackModelAdapter('old-model')
  });

  await orchestrator.runTask('task-deferred-model');

  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].activeModel, 'new-model');

  // During switching_model, activeModel must still be the OLD model
  assert.ok(modelDuringSwitching.length > 0, 'Must observe switching_model state');
  for (const m of modelDuringSwitching) {
    assert.equal(m, 'old-model',
      'activeModel must remain old-model during switching_model');
  }

  // During validating_handoff, activeModel must still be the OLD model
  assert.ok(modelDuringValidating.length > 0, 'Must observe validating_handoff state');
  for (const m of modelDuringValidating) {
    assert.equal(m, 'old-model',
      'activeModel must remain old-model during validating_handoff');
  }
});

test('successful validation changes activeModel to target', async () => {
  const tasks = [createTestTask('task-valid-switch', 'Test activeModel changes only after validation')];
  const modelAtRunningAfterValidation = [];
  let sawValidatingHandoff = false;

  const orchestrator = createTestOrchestrator({
    tasks,
    onSave: nextTasks => {
      if (nextTasks[0].status === 'validating_handoff') {
        sawValidatingHandoff = true;
      }
      if (sawValidatingHandoff && nextTasks[0].status === 'running') {
        modelAtRunningAfterValidation.push(nextTasks[0].activeModel);
        sawValidatingHandoff = false;
      }
    },
    modelRouter: createTwoModelRouter('before-model', 'after-model'),
    modelAdapter: createFallbackModelAdapter('before-model')
  });

  await orchestrator.runTask('task-valid-switch');

  assert.equal(tasks[0].status, 'completed');

  // At the running transition after validation, activeModel must be the target
  assert.ok(modelAtRunningAfterValidation.length > 0,
    'Must observe running state after validating_handoff');
  assert.equal(modelAtRunningAfterValidation[0], 'after-model',
    'activeModel must be set to target model at the running transition after validation');
});

test('failed validation leaves activeModel unchanged', async () => {
  const tasks = [createTestTask('task-fail-keeps-model', 'Test failed validation does not change activeModel')];

  const orchestrator = createTestOrchestrator({
    tasks,
    modelRouter: createTwoModelRouter('keep-this-model', 'rejected-model'),
    modelAdapter: createFallbackModelAdapter('keep-this-model', 'Should not reach here.'),
    validateHandoff: () => ({
      valid: false,
      errors: ['Rejected by validator'],
      warnings: []
    })
  });

  await orchestrator.runTask('task-fail-keeps-model');

  assert.equal(tasks[0].status, 'paused');
  // activeModel must still be the ORIGINAL model, not the rejected target
  assert.equal(tasks[0].activeModel, 'keep-this-model',
    'Failed validation must NOT change activeModel to the target');
});

test('switching message records correct previous model', async () => {
  const tasks = [createTestTask('task-switch-msg', 'Test switching message uses previous model')];
  let switchingMessage = null;

  const orchestrator = createTestOrchestrator({
    tasks,
    onSave: nextTasks => {
      if (nextTasks[0].status === 'switching_model' && !switchingMessage) {
        switchingMessage = nextTasks[0].message;
      }
    },
    modelRouter: createTwoModelRouter('from-model', 'to-model'),
    modelAdapter: createFallbackModelAdapter('from-model')
  });

  await orchestrator.runTask('task-switch-msg');

  assert.ok(switchingMessage, 'Must capture switching_model message');
  assert.equal(switchingMessage, 'Switching from from-model to to-model.',
    'Switching message must reference the previous model, not the target');
});