import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { openStore } from './store.mjs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createToolBroker } from './tools/tool-broker.mjs';
import { createFilesystemBroker } from './tools/filesystem-broker.mjs';
import { buildChangeDiff } from './tools/change-diff.mjs';
import { createOrchestrator } from './orchestrator/orchestrator.mjs';
import { ollamaChat } from './providers/ollama.mjs';
import {
  discoverOllamaModels,
  probeOllamaModel
} from './providers/ollama-catalog.mjs';
import { createCapabilityRegistry } from './router/capability-registry.mjs';
import { createModelRouter } from './router/model-router.mjs';
import { createEventEmitter } from './events/event-emitter.mjs';
import { createOrchestratorBridge } from './events/orchestrator-bridge.mjs';
import {
  MAX_TRANSCRIPT_MESSAGES,
  sanitizeApprovalRequest,
  sanitizeRecoveryToolAction,
  sanitizeTaskSnapshot,
  sanitizeTaskTranscriptMessage
} from './events/event-schema.mjs';

const appRoot = resolve(process.cwd());
// DATA_ROOT is a server-configuration override (used by hermetic tests); the
// default remains the application-local data directory.
const dataRoot = resolve(process.env.DATA_ROOT || join(appRoot, '.continuity-agent'));
const publicFile = join(appRoot, 'src', 'index.html');
const port = Number(process.env.PORT || 4317);
const projectRoot = resolve(process.env.PROJECT_ROOT || appRoot);

// Sole filesystem authority for the project explorer APIs. The root is fixed
// here by server configuration; no client input can ever widen it. All path
// validation (traversal, symlinks, sensitive paths, size/entry bounds) is
// owned by this broker, not by the HTTP layer.
const projectFilesystem = createFilesystemBroker({
  projectRoot,
  allowAbsolute: false
});

// Real-time event layer
const eventEmitter = createEventEmitter();


const defaultConfig = {
  provider: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  preferredModel: '',
  fallbacks: [],
  maxSteps: 6,
  allowedCommands: ['npm', 'node', 'git', 'rg', 'ls', 'pwd'],
  networkToolsEnabled: false,
  allowWrites: false
};

await mkdir(dataRoot, { recursive: true });

const store = await openStore(dataRoot);
const capabilityRegistry = createCapabilityRegistry();

const getTasks = () => store.getTasks();
const saveTasks = tasks => store.saveTasks(tasks);

function normalizeConfig(input = {}) {
  const endpoint =
    typeof input.endpoint === 'string'
      ? input.endpoint.trim().replace(/\/$/, '')
      : defaultConfig.endpoint;

  let endpointUrl;

  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error('The local runtime endpoint must be a valid URL.');
  }

  if (
    endpointUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(endpointUrl.hostname)
  ) {
    throw new Error(
      'Only a local HTTP runtime endpoint is allowed in zero-cost local mode.'
    );
  }

  const models = value =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .filter(item => typeof item === 'string')
              .map(item => item.trim())
              .filter(Boolean)
          )
        ].slice(0, 8)
      : [];

  return {
    ...defaultConfig,
    endpoint,
    preferredModel:
      typeof input.preferredModel === 'string'
        ? input.preferredModel.trim().slice(0, 120)
        : '',
    fallbacks: models(input.fallbacks),
    maxSteps: Number.isInteger(input.maxSteps)
      ? Math.min(20, Math.max(1, input.maxSteps))
      : defaultConfig.maxSteps,
    allowedCommands: models(input.allowedCommands).filter(command =>
      /^[a-z0-9._-]+$/i.test(command)
    ),
    networkToolsEnabled: false,
    allowWrites: input.allowWrites === true
  };
}

const getConfig = async () => normalizeConfig(store.getConfig());

const saveConfig = config =>
  store.saveConfig(normalizeConfig(config));

async function refreshOllamaCapabilities(endpoint) {
  const discovered = await discoverOllamaModels(endpoint);

  for (const model of discovered) {
    try {
      const capability = await probeOllamaModel(
        endpoint,
        model.modelId
      );

      capabilityRegistry.upsert(capability);
    } catch (error) {
      console.warn(
        `Could not probe Ollama model ${model.modelId}: ${error.message}`
      );
    }
  }

  return capabilityRegistry.getAll();
}

async function refreshConfiguredOllamaCapabilities() {
  const config = await getConfig();

  try {
    return await refreshOllamaCapabilities(config.endpoint);
  } catch (error) {
    console.warn(
      `Could not refresh Ollama capabilities: ${error.message}`
    );

    return capabilityRegistry.getAll();
  }
}

const modelRouter = createModelRouter({
  registry: capabilityRegistry,
  config: {
    fallbackOrder: []
  }
});

await refreshConfiguredOllamaCapabilities();

const getToolBroker = async () =>
  createToolBroker(projectRoot, await getConfig());

// Orchestrator bridge translates generic emit('task', task) calls into typed events
const bridge = createOrchestratorBridge(eventEmitter);

// Track previous task statuses so the bridge can emit state_changed events
const taskStatusCache = new Map();

function emit(type, payload) {
  if (type === 'task' && payload && payload.id) {
    const previousStatus = taskStatusCache.get(payload.id);
    taskStatusCache.set(payload.id, payload.status);
    bridge.onTaskUpdated(payload, previousStatus);
    // Legacy support for index.html
    eventEmitter.broadcastRaw(`event: task\ndata: ${JSON.stringify(payload)}\n\n`);
  } else if (type === 'checkpoint' && payload?.taskId && payload?.checkpoint) {
    bridge.onCheckpointCreated(payload.taskId, payload.checkpoint);
  } else if (type === 'step_started' && payload?.taskId) {
    bridge.onStepStarted(payload.taskId, payload.step, payload.activeModel);
  } else if (type === 'tool_started' && payload?.taskId && payload?.toolName) {
    bridge.onToolStarted(payload.taskId, payload.toolName);
  } else if (type === 'tool_completed' && payload?.taskId && payload?.toolName) {
    bridge.onToolCompleted(payload.taskId, payload.toolName, payload.detail);
  } else if (type === 'tool_failed' && payload?.taskId && payload?.toolName) {
    bridge.onToolFailed(payload.taskId, payload.toolName, payload.error);
  } else if (type === 'model_switching' && payload?.taskId) {
    bridge.onModelSwitching(payload.taskId, payload.previousModel, payload.targetModel, payload.reason);
  } else if (type === 'model_switched' && payload?.taskId) {
    bridge.onModelSwitched(payload.taskId, payload.previousModel, payload.targetModel);
  } else if (type === 'recovery_required' && payload?.taskId) {
    bridge.onRecoveryRequired(payload.taskId, payload.reason);
  } else if (type === 'approval_required' && payload?.taskId) {
    bridge.onApprovalRequired(
      payload.taskId,
      payload.approvalId,
      payload.message
    );
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });

  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  let body = '';

  for await (const chunk of request) {
    body += chunk;

    if (body.length > 100_000) {
      throw new Error('Request body is too large.');
    }
  }

  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

const BINARY_SNIFF_BYTES = 8 * 1024;
const BINARY_CONTROL_RATIO = 0.1;

// Heuristic text/binary classification over a bounded sample: NUL bytes or a
// high share of non-whitespace control bytes mark binary payloads. Binary
// content is never returned to clients; only metadata travels as JSON.
function isProbablyText(content) {
  const sample = content.subarray(0, BINARY_SNIFF_BYTES);

  if (sample.includes(0)) {
    return false;
  }

  let controlBytes = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) {
      controlBytes += 1;
    }
  }

  return sample.length === 0 || controlBytes / sample.length <= BINARY_CONTROL_RATIO;
}

function parsePositiveInt(raw) {
  if (raw === null) {
    return undefined;
  }

  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// Broker failures that stem from the client's requested path are client
// errors; anything else is a server fault and must not leak its message.
function isMissingPathError(message) {
  return message.includes('not found');
}

function isClientPathError(message) {
  return (
    message.startsWith('Invalid path') ||
    message.includes('Absolute paths are not permitted') ||
    message.includes('Path traversal detected') ||
    message.includes('Symlink traversal detected') ||
    message.includes('escapes approved project root') ||
    message.includes('sensitive file or directory is blocked') ||
    message.includes('exceeds maximum allowed limit') ||
    message.includes('Target is not a')
  );
}

// Defense in depth: broker messages already reference project-relative paths
// only, but never let a host path reach a client even if a message changes.
function scrubHostPaths(message) {
  let scrubbed = message;

  for (const root of [
    projectFilesystem.canonicalRoot,
    projectFilesystem.projectRoot
  ]) {
    if (root && root !== '/') {
      scrubbed = scrubbed.split(root).join('[redacted]');
    }
  }

  return scrubbed;
}

function respondToProjectPathError(response, error) {
  const message =
    typeof error?.message === 'string' && error.message
      ? error.message
      : 'Unexpected error.';

  if (isMissingPathError(message)) {
    return json(response, 404, { error: scrubHostPaths(message) });
  }

  if (isClientPathError(message)) {
    return json(response, 400, { error: scrubHostPaths(message) });
  }

  return json(response, 500, { error: 'Project file request failed.' });
}

// Pure string validation for the read-only diff API's optional path filter.
// It follows the filesystem broker's project-relative conventions WITHOUT any
// filesystem access: evidence paths are matched exactly against persisted
// rows, so a filter never resolves against the host filesystem.
function isSafeRelativeProjectPath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) {
    return false;
  }
  const segments = value.split(/[\\/]/);
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  return !projectFilesystem.isSensitive(value, segments[segments.length - 1]);
}

const toolSpec = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files inside the approved project directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 file inside the approved project directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write a UTF-8 file inside the approved project directory. Use only after reading or listing relevant files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run an allowlisted command without a shell. Available commands are provided in the system message.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['command', 'args']
      }
    }
  }
];

const orchestrator = createOrchestrator({
  getTasks,
  saveTasks,
  getConfig,
  toolBrokerFactory: getToolBroker,
  modelAdapter: ollamaChat,
  modelRouter,
  toolSpec,
  projectRoot,
  emit,
  store
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url,
      `http://${request.headers.host}`
    );

    if (url.pathname === '/events') {
      // Parse Last-Event-ID header or query param for reconnect support
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastSeqParam = url.searchParams.get('lastSeq');
      const lastSeq = Number(lastEventIdHeader || lastSeqParam) || 0;

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });

      // Send SSE comment with current seq so the client knows its stream position
      const currentSeq = eventEmitter.getLatestSeq();
      response.write(`: ready seq=${currentSeq}\n\n`);

      const unsubscribe = eventEmitter.subscribe(response, lastSeq);

      request.on('close', () => unsubscribe());
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/'
    ) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate',
        'pragma': 'no-cache',
        'expires': '0'
      });

      response.end(await readFile(publicFile));
      return;
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/tasks'
    ) {
      return json(response, 200, await getTasks());
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/config'
    ) {
      return json(response, 200, {
        ...await getConfig(),
        projectRoot
      });
    }

    if (
      request.method === 'PUT' &&
      url.pathname === '/api/config'
    ) {
      const next = normalizeConfig({
        ...await getConfig(),
        ...await bodyOf(request)
      });

      await saveConfig(next);
      await refreshConfiguredOllamaCapabilities();

      return json(response, 200, next);
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/models'
    ) {
      return json(response, 200, {
        models: capabilityRegistry.getAll()
      });
    }

    if (
      request.method === 'GET' &&
      url.pathname === '/api/health'
    ) {
      const config = await getConfig();

      try {
        const tagsResponse = await fetch(
          `${config.endpoint}/api/tags`,
          {
            signal: AbortSignal.timeout(1500)
          }
        );

        if (!tagsResponse.ok) {
          throw new Error(
            `Ollama returned ${tagsResponse.status}`
          );
        }

        const tags = await tagsResponse.json();

        return json(response, 200, {
          reachable: true,
          models: Array.isArray(tags.models)
            ? tags.models.map(model => model.name)
            : [],
          endpoint: config.endpoint
        });
      } catch {
        return json(response, 200, {
          reachable: false,
          models: [],
          endpoint: config.endpoint,
          reason:
            'Start a local Ollama runtime, then refresh the page.'
        });
      }
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/api/tasks'
    ) {
      const body = await bodyOf(request);

      if (!body.goal?.trim()) {
        return json(response, 400, {
          error: 'A task goal is required.'
        });
      }

      const task = {
        id: randomUUID(),
        goal: body.goal.trim(),
        status: 'queued',
        message: 'Waiting to start.',
        activeModel: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [],
        checkpoints: [],
        switches: []
      };

      const tasks = await getTasks();
      tasks.unshift(task);

      // Persist the initial queued transition in the durable task event history
      if (store?.recordTaskTransition) {
        store.recordTaskTransition({
          task,
          previousStatus: 'draft',
          nextStatus: 'queued',
          reason: 'Task created'
        });
      } else if (store?.recordTaskEvent) {
        store.recordTaskEvent({
          taskId: task.id,
          previousStatus: 'draft',
          nextStatus: 'queued',
          timestamp: task.createdAt,
          reason: 'Task created'
        });
      }

      await saveTasks(tasks);
      // Seed status cache and emit typed task_created event
      taskStatusCache.set(task.id, task.status);
      bridge.onTaskCreated(task);

      queueMicrotask(() => orchestrator.runTask(task.id));

      return json(response, 201, task);
    }

    const pauseMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/pause$/
    );

    if (
      request.method === 'POST' &&
      pauseMatch
    ) {
      const taskId = pauseMatch[1];
      const result = await orchestrator.pauseTask(taskId);
      if (!result.ok) {
        return json(response, result.statusCode || 400, {
          error: result.error || 'Could not pause task.'
        });
      }

      return json(response, 200, { ok: true, status: result.status });
    }

    const approvalMatch = url.pathname.match(
      /^\/api\/approvals\/([^/]+)\/(approve|deny)$/
    );

    if (
      request.method === 'POST' &&
      approvalMatch
    ) {
      const approvalId = approvalMatch[1];
      const decision = approvalMatch[2];

      let body;
      try {
        body = await bodyOf(request);
      } catch (error) {
        return json(response, 400, {
          error: error.message || 'Invalid request body.'
        });
      }

      const approval = store?.getApprovalRequest?.(approvalId);

      if (!approval) {
        return json(response, 404, {
          error: 'Approval request not found.'
        });
      }

      if (
        body.taskId !== undefined &&
        body.taskId !== null &&
        String(body.taskId) !== String(approval.taskId)
      ) {
        return json(response, 409, {
          error: 'Approval request task binding mismatch.'
        });
      }

      const taskId = String(approval.taskId);

      const tasks = await getTasks();
      const task = tasks.find(item => item.id === taskId);

      if (!task) {
        return json(response, 404, {
          error: 'Approval request task not found.'
        });
      }

      if (decision === 'deny') {
        if (approval.status !== 'pending') {
          return json(response, 409, {
            error: `Approval request is already resolved with status "${approval.status}".`,
            approval: store.getApprovalRequest(approvalId)
          });
        }

        let resolved;
        try {
          resolved = store.resolveApprovalRequest(approvalId, {
            status: 'denied',
            resolutionReason: 'User denied the approval request.'
          });
        } catch (error) {
          return json(response, 409, {
            error: error.message || 'Approval request could not be denied.'
          });
        }

        if (task.status === 'awaiting_approval') {
          await orchestrator.updateTask(task, item => {
            item.status = 'paused';
            item.message = 'Approval denied. Task paused.';
            orchestrator.checkpoint(
              item,
              'Approval denied'
            );
          });
        }

        return json(response, 200, {
          ok: true,
          decision: 'denied',
          approval: resolved,
          action: store.getToolAction(resolved.toolActionId)
        });
      }

      if (approval.status === 'pending') {
        try {
          store.resolveApprovalRequest(approvalId, {
            status: 'approved',
            resolutionReason: 'User approved the approval request.'
          });
        } catch (error) {
          return json(response, 409, {
            error: error.message || 'Approval request could not be approved.'
          });
        }
      } else if (
        approval.status !== 'approved' &&
        approval.status !== 'consumed'
      ) {
        return json(response, 409, {
          error: `Approval request is not executable in status "${approval.status}".`,
          approval: store.getApprovalRequest(approvalId)
        });
      }

      let execution;
      try {
        execution = await orchestrator.executeApprovedAction({
          approvalId,
          taskId
        });
      } catch (error) {
        return json(response, 409, {
          error: error.message || 'Approved action could not be executed.'
        });
      }

      if (execution?.resumed) {
        setImmediate(() => {
          orchestrator.runTask(taskId).catch(() => {});
        });
      }

      return json(response, 200, {
        ok: true,
        decision: 'approved',
        ...execution
      });
    }

    const match = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/continue$/
    );
    if (
      request.method === 'POST' &&
      match
    ) {
      const resumed = await orchestrator.resumeTask(match[1]);

      if (!resumed.ok) {
        return json(response, resumed.statusCode || 409, {
          error: resumed.error,
          recoveryRequired: Boolean(resumed.recoveryRequired)
        });
      }

      return json(response, 202, { ok: true });
    }
    // GET /api/tasks/:id/snapshot
    // Returns a bounded, sanitized snapshot of one task for UI reconnect.
    // Intent: snapshot first -> event stream (from /events?lastSeq=N) -> continue.
    const snapshotMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/snapshot$/
    );

    if (
      request.method === 'GET' &&
      snapshotMatch
    ) {
      const allTasks = await getTasks();
      const found = allTasks.find(t => t.id === snapshotMatch[1]);

      if (!found) {
        return json(response, 404, { error: 'Task not found.' });
      }

      return json(response, 200, {
        task: sanitizeTaskSnapshot(found),
        currentSeq: eventEmitter.getLatestSeq(),
        source: 'sqlite'
      });
    }

    // GET /api/tasks/:id/approval
    // Returns the currently pending durable approval for one task.
    // Read-only: mutation arguments are never accepted from the client.
    const taskApprovalMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/approval$/
    );
    if (
      request.method === 'GET' &&
      taskApprovalMatch
    ) {
      const taskId = taskApprovalMatch[1];
      const allTasks = await getTasks();
      const found = allTasks.find(task => task.id === taskId);

      if (!found) {
        return json(response, 404, {
          error: 'Task not found.'
        });
      }

      let approval;
      try {
        approval = store.getPendingApprovalRequestForTask(taskId);
      } catch {
        return json(response, 500, {
          error: 'Approval request could not be read safely.'
        });
      }

      if (!approval) {
        return json(response, 404, {
          error: 'No pending approval request for this task.'
        });
      }

      return json(response, 200, {
        taskId,
        approval: sanitizeApprovalRequest(approval),
        source: 'sqlite'
      });
    }

    // GET /api/tasks/:id/transcript?limit=N
    // Returns a bounded, sanitized read-only durable execution transcript.
    const transcriptMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/transcript$/
    );
    if (
      request.method === 'GET' &&
      transcriptMatch
    ) {
      const taskId = transcriptMatch[1];
      const allTasks = await getTasks();
      const found = allTasks.find(t => t.id === taskId);

      if (!found) {
        return json(response, 404, {
          error: 'Task not found.'
        });
      }

      const requestedLimit = Number.parseInt(
        url.searchParams.get('limit') || '',
        10
      );

      const limit =
        Number.isInteger(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, MAX_TRANSCRIPT_MESSAGES)
          : MAX_TRANSCRIPT_MESSAGES;

      let persistedMessages;

      try {
        persistedMessages = store.getTaskMessages(taskId);
      } catch {
        return json(response, 500, {
          error: 'Task transcript could not be read safely.'
        });
      }

      const totalCount = persistedMessages.length;
      const selected = persistedMessages.slice(-limit);

      return json(response, 200, {
        taskId,
        messages: selected.map(sanitizeTaskTranscriptMessage),
        returnedCount: selected.length,
        totalCount,
        truncated: totalCount > selected.length,
        source: 'sqlite'
      });
    }

    // GET /api/events/status
    // Returns event stream metadata (current seq, buffer size, client count).
    if (
      request.method === 'GET' &&
      url.pathname === '/api/events/status'
    ) {
      return json(response, 200, {
        currentSeq: eventEmitter.getLatestSeq(),
        clientCount: eventEmitter.clientCount(),
        ...eventEmitter.getBufferStats()
      });
    }

    // ---- Project Explorer (read-only) ----
    // GET /api/project/files?path=.&limit=N
    // Bounded, project-scoped recursive file listing. Empty/absent path lists
    // from the project root. Entry bounds, traversal/symlink/sensitive-path
    // protection are enforced by the filesystem broker. The optional limit is
    // passed through to the broker, which owns all clamping; this layer does
    // not report truncation because the broker contract does not provide it.
    if (
      request.method === 'GET' &&
      url.pathname === '/api/project/files'
    ) {
      const requestedPath = url.searchParams.get('path') ?? '.';
      const requestedLimit = parsePositiveInt(url.searchParams.get('limit'));

      try {
        const listing = await projectFilesystem.listFiles(requestedPath, {
          limit: requestedLimit
        });

        return json(response, 200, {
          ok: true,
          path: requestedPath || '.',
          files: listing.files
        });
      } catch (error) {
        return respondToProjectPathError(response, error);
      }
    }

    // GET /api/project/file?path=<relative-path>
    // Returns UTF-8 text content for a permitted project file. Binary
    // payloads are reported as metadata only (binary: true, no content) and
    // are never streamed back as text.
    if (
      request.method === 'GET' &&
      url.pathname === '/api/project/file'
    ) {
      const requestedPath = url.searchParams.get('path') ?? '';

      try {
        const result = await projectFilesystem.readFile(requestedPath);

        if (!isProbablyText(Buffer.from(result.content, 'utf8'))) {
          return json(response, 200, {
            path: result.path,
            size: result.size,
            binary: true,
            contentType: 'application/octet-stream'
          });
        }

        return json(response, 200, {
          path: result.path,
          size: result.size,
          binary: false,
          encoding: 'utf-8',
          content: result.content
        });
      } catch (error) {
        return respondToProjectPathError(response, error);
      }
    }

    // GET /api/tasks/:id/recovery
    // Read-only recovery inspection for durable tool actions parked in
    // needs_verification. This endpoint never executes, retries, mutates,
    // or re-authorizes an uncertain action.
    const recoveryMatch = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/recovery$/
    );
    if (
      request.method === 'GET' &&
      recoveryMatch
    ) {
      let taskId;
      try {
        taskId = decodeURIComponent(recoveryMatch[1]);
      } catch {
        return json(response, 400, {
          error: 'Invalid task identifier.'
        });
      }

      try {
        const task = store?.getTask?.(taskId);

        if (!task) {
          return json(response, 404, {
            error: 'Task not found.'
          });
        }

        const result = store.getNeedsVerificationToolActions(taskId);

        const actions = result.actions.map(action => {
          const evidence = store.getToolActionEvidence(action.id);
          return sanitizeRecoveryToolAction(action, evidence);
        });

        return json(response, 200, {
          ok: true,
          taskId,
          source: 'sqlite',
          limit: result.limit,
          total: result.total,
          count: actions.length,
          truncated: result.truncated,
          actions
        });
      } catch {
        return json(response, 500, {
          error: 'Recovery state could not be read safely.'
        });
      }
    }

    // GET /api/project/changes?taskId=<id>&path=<relative-path>&limit=<n>
    // Read-only Diff API: transforms durable file_change_evidence rows into a
    // deterministic diff representation. The persisted evidence is the sole
    // source of truth — this endpoint never reads the filesystem, executes
    // tools, or mutates any state.
    if (
      request.method === 'GET' &&
      url.pathname === '/api/project/changes'
    ) {
      const taskId = (url.searchParams.get('taskId') || '').trim();
      if (!taskId) {
        return json(response, 400, {
          error: 'A taskId query parameter is required.'
        });
      }

      const pathFilterRaw = url.searchParams.get('path');
      let pathFilter = null;
      if (pathFilterRaw !== null) {
        if (!isSafeRelativeProjectPath(pathFilterRaw)) {
          return json(response, 400, {
            error:
              'Invalid path filter: a non-empty project-relative path without traversal or sensitive segments is required.'
          });
        }
        pathFilter = pathFilterRaw;
      }

      try {
        const task = await store.getTask(taskId);
        if (!task) {
          return json(response, 404, { error: 'Task not found.' });
        }

        const result = store.getFileChangeEvidence({
          taskId,
          path: pathFilter,
          limit: url.searchParams.get('limit')
        });

        return json(response, 200, {
          ok: true,
          taskId,
          path: pathFilter,
          limit: result.limit,
          total: result.total,
          count: result.changes.length,
          truncated: result.truncated,
          changes: result.changes.map(buildChangeDiff)
        });
      } catch (error) {
        // Fail closed without leaking SQLite or filesystem internals.
        console.error(
          'Could not retrieve file change evidence:',
          error?.message || error
        );
        return json(response, 500, {
          error: 'Could not retrieve file changes.'
        });
      }
    }

    return json(response, 404, {
      error: 'Not found.'
    });
  } catch (error) {
    return json(
      response,
      error.message?.includes('must') ||
        error.message?.includes('too large')
        ? 400
        : 500,
      {
        error: error.message || 'Unexpected error.'
      }
    );
  }
});

server.on('error', error => {
  console.error(
    `Continuity Agent could not start: ${error.message}`
  );

  process.exitCode = 1;
});

server.listen(
  port,
  '127.0.0.1',
  () =>
    console.log(
      `Continuity Agent is running at http://127.0.0.1:${port}`
    )
);