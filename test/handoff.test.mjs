import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHandoffPacket,
  clampBound,
  MAX_RECENT_ITEMS,
  MAX_STRING_LENGTH,
  MAX_DETAIL_LENGTH
} from '../src/orchestrator/handoff.mjs';

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

test('normal packet creation creates a structured handoff packet', () => {
  const task = {
    id: 'task-100',
    goal: 'Refactor test suite',
    status: 'paused',
    message: 'Step limit reached; checkpoint saved.',
    activeModel: 'qwen3:4b',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:05:00.000Z',
    steps: [
      {
        at: '2026-09-12T10:01:00.000Z',
        kind: 'tool',
        name: 'read_file',
        detail: '{"path":"test/sample.test.mjs"}'
      }
    ],
    checkpoints: [
      {
        id: 'cp-1',
        createdAt: '2026-09-12T10:01:30.000Z',
        event: 'Tool completed: read_file',
        status: 'running',
        activeModel: 'qwen3:4b',
        step: 1,
        workspace: '/tmp/project'
      }
    ],
    switches: [
      {
        at: '2026-09-12T10:00:10.000Z',
        model: 'qwen3:4b',
        reason: 'Selected local model'
      }
    ]
  };

  const packet = createHandoffPacket(task);

  assert.ok(packet);
  assert.equal(typeof packet, 'object');
  assert.equal(packet.taskId, 'task-100');
  assert.equal(packet.originalGoal, 'Refactor test suite');
  assert.equal(packet.currentStatus, 'paused');
  assert.equal(packet.activeModel, 'qwen3:4b');
  assert.equal(packet.currentStepNumber, 1);
  assert.ok(packet.latestCheckpoint);
  assert.equal(packet.latestCheckpoint.event, 'Tool completed: read_file');
  assert.equal(packet.latestCheckpointEvent, 'Tool completed: read_file');
  assert.equal(packet.recentSteps.length, 1);
  assert.equal(packet.recentCheckpoints.length, 1);
  assert.equal(packet.recentModelSwitches.length, 1);
  assert.ok(Array.isArray(packet.recentErrors));
  assert.ok(packet.resumeContext);
  assert.equal(packet.resumeContext.canResume, true);
  assert.equal(packet.resumeContext.recommendedAction, 'resume');
});

test('correct core fields are properly populated and mapped', () => {
  const task = {
    id: 'task-core-1',
    goal: 'Build feature X',
    status: 'running',
    activeModel: 'llama3:8b',
    message: 'Executing tool',
    steps: [
      {
        at: '2026-09-12T12:00:00.000Z',
        kind: 'assistant',
        model: 'llama3:8b',
        detail: 'I will inspect the files.'
      },
      {
        at: '2026-09-12T12:01:00.000Z',
        kind: 'model_error',
        model: 'llama3:8b',
        detail: 'Timeout communicating with model adapter',
        errorType: 'transient',
        retryAttempt: 1
      }
    ],
    checkpoints: [
      {
        id: 'cp-start',
        createdAt: '2026-09-12T11:59:00.000Z',
        event: 'Run started',
        status: 'running',
        activeModel: 'llama3:8b',
        step: 0
      },
      {
        id: 'cp-err',
        createdAt: '2026-09-12T12:01:10.000Z',
        event: 'Retry 1 for llama3:8b',
        status: 'running',
        activeModel: 'llama3:8b',
        step: 2
      }
    ],
    switches: [
      {
        at: '2026-09-12T11:58:00.000Z',
        model: 'llama3:8b',
        reason: 'Initial model selection'
      }
    ]
  };

  const packet = createHandoffPacket(task);

  // Core fields
  assert.equal(packet.taskId, 'task-core-1');
  assert.equal(packet.id, 'task-core-1');
  assert.equal(packet.originalGoal, 'Build feature X');
  assert.equal(packet.goal, 'Build feature X');
  assert.equal(packet.currentStatus, 'running');
  assert.equal(packet.status, 'running');
  assert.equal(packet.activeModel, 'llama3:8b');
  assert.equal(packet.currentStepNumber, 2);
  assert.equal(packet.currentStep, 2);
  assert.equal(packet.stepNumber, 2);

  // Latest checkpoint event/time
  assert.equal(packet.latestCheckpointEvent, 'Retry 1 for llama3:8b');
  assert.equal(packet.latestCheckpointTime, '2026-09-12T12:01:10.000Z');
  assert.equal(packet.latestCheckpoint.event, 'Retry 1 for llama3:8b');
  assert.equal(packet.latestCheckpoint.time, '2026-09-12T12:01:10.000Z');

  // Recent errors extraction
  assert.equal(packet.recentErrors.length, 1);
  assert.equal(packet.recentErrors[0].type, 'transient');
  assert.equal(packet.recentErrors[0].message, 'Timeout communicating with model adapter');
  assert.equal(packet.recentErrors[0].model, 'llama3:8b');

  // Resume context
  assert.equal(packet.resumeContext.canResume, true);
  assert.equal(packet.resumeContext.status, 'running');
  assert.equal(packet.resumeContext.stepNumber, 2);
  assert.equal(packet.resumeContext.activeModel, 'llama3:8b');
  assert.equal(packet.resumeContext.hasErrors, true);
  assert.equal(packet.resumeContext.recommendedAction, 'continue');
});

test('missing checkpoint handling safely defaults without errors', () => {
  // Empty checkpoints array
  const emptyCpTask = {
    id: 'task-no-cp',
    goal: 'Goal without checkpoint',
    status: 'queued',
    checkpoints: []
  };
  const packet1 = createHandoffPacket(emptyCpTask);
  assert.equal(packet1.latestCheckpoint, null);
  assert.equal(packet1.latestCheckpointEvent, null);
  assert.equal(packet1.latestCheckpointTime, null);
  assert.deepEqual(packet1.recentCheckpoints, []);

  // Undefined / null checkpoints and missing arrays
  const nullArraysTask = {
    id: 'task-null-arrays',
    checkpoints: null,
    steps: null,
    switches: null,
    errors: null
  };
  const packet2 = createHandoffPacket(nullArraysTask);
  assert.equal(packet2.latestCheckpoint, null);
  assert.equal(packet2.latestCheckpointEvent, null);
  assert.equal(packet2.latestCheckpointTime, null);
  assert.deepEqual(packet2.recentCheckpoints, []);
  assert.deepEqual(packet2.recentSteps, []);
  assert.deepEqual(packet2.recentModelSwitches, []);
  assert.deepEqual(packet2.recentErrors, []);
  assert.equal(packet2.currentStepNumber, 0);

  // Completely empty object
  const emptyTask = {};
  const packet3 = createHandoffPacket(emptyTask);
  assert.equal(packet3.taskId, '');
  assert.equal(packet3.originalGoal, '');
  assert.equal(packet3.currentStatus, 'draft');
  assert.equal(packet3.latestCheckpoint, null);
  assert.deepEqual(packet3.recentCheckpoints, []);

  // Null and undefined inputs
  const packet4 = createHandoffPacket(null);
  assert.equal(packet4.taskId, '');
  assert.equal(packet4.latestCheckpoint, null);

  const packet5 = createHandoffPacket(undefined);
  assert.equal(packet5.taskId, '');
  assert.equal(packet5.latestCheckpoint, null);
});

test('array bounds restrict recent collections to fixed maximum', () => {
  const steps = [];
  const checkpoints = [];
  const switches = [];
  const errors = [];

  for (let i = 0; i < 30; i++) {
    steps.push({
      at: `2026-09-12T10:${String(i).padStart(2, '0')}:00.000Z`,
      kind: 'tool',
      name: `tool_${i}`,
      detail: `Result of step ${i}`
    });
    checkpoints.push({
      id: `cp-${i}`,
      createdAt: `2026-09-12T10:${String(i).padStart(2, '0')}:30.000Z`,
      event: `Checkpoint event ${i}`,
      step: i
    });
    switches.push({
      at: `2026-09-12T10:${String(i).padStart(2, '0')}:05.000Z`,
      model: `model-${i}`,
      reason: `Switch reason ${i}`
    });
    errors.push({
      at: `2026-09-12T10:${String(i).padStart(2, '0')}:50.000Z`,
      type: 'transient',
      message: `Error occurrence ${i}`
    });
  }

  const task = {
    id: 'task-large-arrays',
    goal: 'Boundary test',
    status: 'running',
    steps,
    checkpoints,
    switches,
    errors
  };

  const packet = createHandoffPacket(task);

  assert.equal(packet.recentSteps.length, MAX_RECENT_ITEMS);
  assert.equal(packet.recentCheckpoints.length, MAX_RECENT_ITEMS);
  assert.equal(packet.recentModelSwitches.length, MAX_RECENT_ITEMS);
  assert.equal(packet.recentErrors.length, MAX_RECENT_ITEMS);

  // Bounds should preserve the most recent items (tail of array)
  assert.equal(packet.recentSteps.at(-1).name, 'tool_29');
  assert.equal(packet.recentSteps[0].name, 'tool_20');
  assert.equal(packet.recentCheckpoints.at(-1).id, 'cp-29');
  assert.equal(packet.recentCheckpoints[0].id, 'cp-20');
  assert.equal(packet.recentModelSwitches.at(-1).model, 'model-29');
  assert.equal(packet.recentModelSwitches[0].model, 'model-20');
  assert.equal(packet.recentErrors.at(-1).message, 'Error occurrence 29');
  assert.equal(packet.recentErrors[0].message, 'Error occurrence 20');

  // Total counts are properly tracked in resumeContext
  assert.equal(packet.resumeContext.totalSteps, 30);
  assert.equal(packet.resumeContext.totalCheckpoints, 30);
  assert.equal(packet.resumeContext.totalSwitches, 30);
});

test('string bounds enforce maximum character limits on long text', () => {
  const longGoal = 'G'.repeat(5000);
  const longDetail = 'D'.repeat(5000);
  const longReason = 'R'.repeat(5000);
  const longErrorMessage = 'E'.repeat(5000);
  const longTaskMessage = 'M'.repeat(5000);

  const task = {
    id: 'task-strings',
    goal: longGoal,
    status: 'paused',
    message: longTaskMessage,
    steps: [
      {
        kind: 'tool',
        detail: longDetail
      }
    ],
    switches: [
      {
        model: 'm1',
        reason: longReason
      }
    ],
    errors: [
      {
        message: longErrorMessage
      }
    ]
  };

  const packet = createHandoffPacket(task);

  assert.equal(packet.originalGoal.length, MAX_STRING_LENGTH);
  assert.equal(packet.recentSteps[0].detail.length, MAX_DETAIL_LENGTH);
  assert.equal(packet.recentModelSwitches[0].reason.length, MAX_DETAIL_LENGTH);
  assert.equal(packet.recentErrors[0].message.length, MAX_DETAIL_LENGTH);
  assert.equal(packet.resumeContext.lastMessage.length, MAX_DETAIL_LENGTH);
});

test('no mutation of input task or its nested objects', () => {
  const originalTask = {
    id: 'task-immutable',
    goal: 'Ensure immutability',
    status: 'running',
    message: 'In progress',
    activeModel: 'qwen3:4b',
    steps: [
      {
        at: '2026-09-12T10:00:00.000Z',
        kind: 'assistant',
        detail: 'Working'
      }
    ],
    checkpoints: [
      {
        id: 'cp-1',
        event: 'Start',
        createdAt: '2026-09-12T10:00:00.000Z',
        step: 1
      }
    ],
    switches: [
      {
        at: '2026-09-12T10:00:00.000Z',
        model: 'qwen3:4b',
        reason: 'Default'
      }
    ],
    errors: [
      {
        message: 'Non-fatal warning'
      }
    ]
  };

  // Deeply freeze the input object to guarantee no property addition/modification
  deepFreeze(originalTask);

  let packet;
  assert.doesNotThrow(() => {
    packet = createHandoffPacket(originalTask);
  });

  // Mutating packet collections should not affect original task
  packet.recentSteps.push({ kind: 'injected' });
  packet.recentSteps[0].detail = 'modified detail';
  packet.recentCheckpoints.push({ id: 'injected-cp' });

  assert.equal(originalTask.steps.length, 1);
  assert.equal(originalTask.steps[0].detail, 'Working');
  assert.equal(originalTask.checkpoints.length, 1);
});

test('sensitive-looking fields are not copied into handoff packet', () => {
  const taskWithSecrets = {
    id: 'task-sensitive',
    goal: 'Validate security filtering',
    status: 'running',
    // Sensitive fields that must NOT be copied
    apiKey: 'sk-1234567890abcdef',
    api_key: 'secret-key-1',
    credentials: { user: 'admin', password: 'supersecretpassword' },
    secret: 'top-secret-value',
    token: 'jwt.token.here',
    processEnv: { PATH: '/bin:/usr/bin', SECRET_KEY: 'env-secret' },
    env: { DB_PASS: 'dbpass' },
    conversation: [
      { role: 'system', content: 'You are an agent' },
      { role: 'user', content: 'Secret prompt content' }
    ],
    fileContents: 'sensitive file contents dump',
    filesystem: { '/etc/passwd': 'root:x:0:0...' },
    arbitraryNestedProps: { deep: { nested: true } },
    steps: [
      {
        at: '2026-09-12T10:00:00.000Z',
        kind: 'tool',
        name: 'read_secret',
        detail: 'Tool completed safely',
        // Sensitive step properties that must NOT be copied
        arguments: { token: 'auth-token' },
        output: 'Full unrestricted tool dump with private tokens',
        tool_calls: [{ id: 'call-1', secret: 'call-secret' }],
        messages: [{ role: 'system', content: 'hidden system prompt' }]
      }
    ],
    checkpoints: [
      {
        id: 'cp-sec',
        event: 'Safe checkpoint',
        createdAt: '2026-09-12T10:00:00.000Z',
        status: 'running',
        activeModel: 'm1',
        step: 1,
        // Sensitive checkpoint properties that must NOT be copied
        workspace: '/root/private/vault',
        fileManifest: ['/private/secret.key'],
        secretsDump: 'restricted'
      }
    ]
  };

  const packet = createHandoffPacket(taskWithSecrets);

  // Verify top-level packet has no sensitive properties
  assert.equal(packet.apiKey, undefined);
  assert.equal(packet.api_key, undefined);
  assert.equal(packet.credentials, undefined);
  assert.equal(packet.secret, undefined);
  assert.equal(packet.token, undefined);
  assert.equal(packet.processEnv, undefined);
  assert.equal(packet.env, undefined);
  assert.equal(packet.conversation, undefined);
  assert.equal(packet.fileContents, undefined);
  assert.equal(packet.filesystem, undefined);
  assert.equal(packet.arbitraryNestedProps, undefined);

  // Verify step object has no sensitive properties
  const step = packet.recentSteps[0];
  assert.equal(step.arguments, undefined);
  assert.equal(step.output, undefined);
  assert.equal(step.tool_calls, undefined);
  assert.equal(step.messages, undefined);

  // Verify checkpoint object has no sensitive properties
  const checkpoint = packet.recentCheckpoints[0];
  assert.equal(checkpoint.workspace, undefined);
  assert.equal(checkpoint.fileManifest, undefined);
  assert.equal(checkpoint.secretsDump, undefined);
});

test('deterministic output for identical input task', () => {
  const task = {
    id: 'task-det-1',
    goal: 'Deterministic verification',
    status: 'paused',
    activeModel: 'qwen3:4b',
    message: 'Execution checkpointed',
    steps: [
      {
        at: '2026-09-12T10:00:00.000Z',
        kind: 'tool',
        name: 'check_tests',
        detail: 'all tests pass'
      },
      {
        at: '2026-09-12T10:01:00.000Z',
        kind: 'model_error',
        model: 'qwen3:4b',
        detail: 'rate limited',
        errorType: 'quota'
      }
    ],
    checkpoints: [
      {
        id: 'cp-det',
        event: 'Model failure: qwen3:4b',
        createdAt: '2026-09-12T10:01:05.000Z',
        status: 'paused',
        activeModel: 'qwen3:4b',
        step: 2
      }
    ],
    switches: [
      {
        at: '2026-09-12T09:59:00.000Z',
        model: 'qwen3:4b',
        reason: 'Initial routing'
      }
    ]
  };

  const packet1 = createHandoffPacket(task);
  const packet2 = createHandoffPacket(task);
  const packet3 = createHandoffPacket(task);

  assert.deepStrictEqual(packet1, packet2);
  assert.deepStrictEqual(packet2, packet3);
});

test('clampBound enforces bounds and resolves safely for invalid, negative, fractional, or oversized values', () => {
  // Valid in-range integers
  assert.equal(clampBound(5, 10, 10), 5);
  assert.equal(clampBound(0, 10, 10), 0);
  assert.equal(clampBound(10, 10, 10), 10);

  // Oversized values clamp to maxBound
  assert.equal(clampBound(11, 10, 10), 10);
  assert.equal(clampBound(999999, 10, 10), 10);
  assert.equal(clampBound(5000, 1000, 1000), 1000);
  assert.equal(clampBound(1200, 500, 500), 500);

  // Negative values resolve safely to defaultValue
  assert.equal(clampBound(-1, 10, 10), 10);
  assert.equal(clampBound(-100, 10, 10), 10);
  assert.equal(clampBound(-500, 1000, 1000), 1000);

  // Fractional values resolve safely to defaultValue
  assert.equal(clampBound(4.7, 10, 10), 10);
  assert.equal(clampBound(0.1, 10, 10), 10);

  // Non-number / invalid values resolve safely to defaultValue
  assert.equal(clampBound(undefined, 10, 10), 10);
  assert.equal(clampBound(null, 10, 10), 10);
  assert.equal(clampBound(NaN, 10, 10), 10);
  assert.equal(clampBound(Infinity, 10, 10), 10);
  assert.equal(clampBound(-Infinity, 10, 10), 10);
  assert.equal(clampBound('50', 10, 10), 10);
  assert.equal(clampBound({}, 10, 10), 10);
});

test('oversized caller options cannot exceed fixed limits in createHandoffPacket', () => {
  const steps = [];
  for (let i = 0; i < 25; i++) {
    steps.push({
      kind: 'tool',
      name: `tool_${i}`,
      detail: 'X'.repeat(2000)
    });
  }

  const task = {
    id: 'task-oversized-opts',
    goal: 'A'.repeat(5000),
    status: 'running',
    steps
  };

  // Attempt to pass huge bounds beyond fixed limits
  const packet = createHandoffPacket(task, {
    maxRecentItems: 99999,
    maxStringLength: 99999,
    maxDetailLength: 99999
  });

  // Must not exceed the fixed limits
  assert.equal(packet.recentSteps.length, MAX_RECENT_ITEMS);
  assert.equal(packet.originalGoal.length, MAX_STRING_LENGTH);
  assert.equal(packet.recentSteps[0].detail.length, MAX_DETAIL_LENGTH);
});

test('negative caller options cannot exceed fixed limits and resolve safely in createHandoffPacket', () => {
  const steps = [];
  for (let i = 0; i < 25; i++) {
    steps.push({
      kind: 'tool',
      name: `tool_${i}`,
      detail: 'Y'.repeat(2000)
    });
  }

  const task = {
    id: 'task-negative-opts',
    goal: 'B'.repeat(5000),
    status: 'running',
    steps
  };

  // Attempt to pass negative bounds
  const packet = createHandoffPacket(task, {
    maxRecentItems: -5,
    maxStringLength: -100,
    maxDetailLength: -50
  });

  // Negative options must resolve safely without exceeding limits
  assert.ok(packet.recentSteps.length <= MAX_RECENT_ITEMS);
  assert.equal(packet.recentSteps.length, MAX_RECENT_ITEMS);
  assert.ok(packet.originalGoal.length <= MAX_STRING_LENGTH);
  assert.equal(packet.originalGoal.length, MAX_STRING_LENGTH);
  assert.ok(packet.recentSteps[0].detail.length <= MAX_DETAIL_LENGTH);
  assert.equal(packet.recentSteps[0].detail.length, MAX_DETAIL_LENGTH);
});

test('valid smaller bounds within [0, MAX] are respected', () => {
  const steps = [];
  for (let i = 0; i < 15; i++) {
    steps.push({
      kind: 'tool',
      name: `tool_${i}`,
      detail: 'Hello world, this is a step detail.'
    });
  }

  const task = {
    id: 'task-custom-opts',
    goal: 'Shorten this goal text for testing custom limits',
    status: 'running',
    steps
  };

  // Pass valid smaller limits
  const packet = createHandoffPacket(task, {
    maxRecentItems: 3,
    maxStringLength: 10,
    maxDetailLength: 5
  });

  assert.equal(packet.recentSteps.length, 3);
  assert.equal(packet.originalGoal.length, 10);
  assert.equal(packet.recentSteps[0].detail.length, 5);

  // Test zero limit
  const zeroPacket = createHandoffPacket(task, {
    maxRecentItems: 0,
    maxStringLength: 0,
    maxDetailLength: 0
  });

  assert.equal(zeroPacket.recentSteps.length, 0);
  assert.equal(zeroPacket.originalGoal, '');
  assert.equal(zeroPacket.resumeContext.lastMessage, '');
});
