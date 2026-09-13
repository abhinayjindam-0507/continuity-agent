import { createServer } from 'node:http';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { openStore } from './store.mjs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { authorizeTool } from './policy.mjs';
import { createToolBroker } from './tools/tool-broker.mjs';
import { createOrchestrator } from './orchestrator/orchestrator.mjs';
import { ollamaChat } from './providers/ollama.mjs';

const appRoot = resolve(process.cwd());
const dataRoot = join(appRoot, '.continuity-agent');
const publicFile = join(appRoot, 'src', 'index.html');
const port = Number(process.env.PORT || 4317);
const projectRoot = resolve(process.env.PROJECT_ROOT || appRoot);
const clients = new Set();

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
const getTasks = () => store.getTasks();
const saveTasks = (tasks) => store.saveTasks(tasks);
function normalizeConfig(input = {}) {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim().replace(/\/$/, '') : defaultConfig.endpoint;
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { throw new Error('The local runtime endpoint must be a valid URL.'); }
  if (endpointUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(endpointUrl.hostname)) throw new Error('Only a local HTTP runtime endpoint is allowed in zero-cost local mode.');
  const models = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 8) : [];
  return {
    ...defaultConfig,
    endpoint,
    preferredModel: typeof input.preferredModel === 'string' ? input.preferredModel.trim().slice(0, 120) : '',
    fallbacks: models(input.fallbacks),
    maxSteps: Number.isInteger(input.maxSteps) ? Math.min(20, Math.max(1, input.maxSteps)) : defaultConfig.maxSteps,
    allowedCommands: models(input.allowedCommands).filter(command => /^[a-z0-9._-]+$/i.test(command)),
    networkToolsEnabled: false,
    allowWrites: input.allowWrites === true
  };
}
const getConfig = async () => normalizeConfig(store.getConfig());
const saveConfig = (config) => store.saveConfig(normalizeConfig(config));
const getToolBroker = async () => createToolBroker(projectRoot, await getConfig());

function emit(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) response.write(message);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error('Request body is too large.');
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw new Error('Request body must be valid JSON.'); }
}

const toolSpec = [
  { type: 'function', function: { name: 'list_files', description: 'List files inside the approved project directory.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 file inside the approved project directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a UTF-8 file inside the approved project directory. Use only after reading or listing relevant files.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run an allowlisted command without a shell. Available commands are provided in the system message.', parameters: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['command', 'args'] } } }
];


const orchestrator = createOrchestrator({
  getTasks,
  saveTasks,
  getConfig,
  toolBrokerFactory: getToolBroker,
  modelAdapter: ollamaChat,
  toolSpec,
  projectRoot,
  emit
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(response); response.write('event: ready\ndata: {}\n\n'); request.on('close', () => clients.delete(response)); return;
    }
    if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(await readFile(publicFile)); return; }
    if (request.method === 'GET' && url.pathname === '/api/tasks') return json(response, 200, await getTasks());
    if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, { ...await getConfig(), projectRoot });
    if (request.method === 'PUT' && url.pathname === '/api/config') { const next = normalizeConfig({ ...await getConfig(), ...await bodyOf(request) }); await saveConfig(next); return json(response, 200, next); }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      const config = await getConfig();
      try { const tags = await (await fetch(`${config.endpoint}/api/tags`, { signal: AbortSignal.timeout(1500) })).json(); return json(response, 200, { reachable: true, models: tags.models?.map(model => model.name) || [], endpoint: config.endpoint }); }
      catch (error) { return json(response, 200, { reachable: false, models: [], endpoint: config.endpoint, reason: 'Start a local Ollama runtime, then refresh this page.' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await bodyOf(request); if (!body.goal?.trim()) return json(response, 400, { error: 'A task goal is required.' });
      const task = { id: randomUUID(), goal: body.goal.trim(), status: 'queued', message: 'Waiting to start.', activeModel: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: [], checkpoints: [], switches: [] };
      const tasks = await getTasks(); tasks.unshift(task); await saveTasks(tasks); emit('task', task); queueMicrotask(() => orchestrator.runTask(task.id)); return json(response, 201, task);
    }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/continue$/);
    if (request.method === 'POST' && match) {
      const tasks = await getTasks();
      const task = tasks.find(item => item.id === match[1]);
      if (!task) return json(response, 404, { error: 'Task not found.' });
      if (task.status === 'paused' || task.status === 'needs_setup') await updateTask(task, item => { item.status = 'queued'; item.message = 'Queued to resume from its latest checkpoint.'; checkpoint(item, 'User requested continuation'); });
      queueMicrotask(() => orchestrator.runTask(match[1]));
      return json(response, 202, { ok: true });
    }
    return json(response, 404, { error: 'Not found.' });
  } catch (error) { return json(response, error.message?.includes('must') || error.message?.includes('too large') ? 400 : 500, { error: error.message || 'Unexpected error.' }); }
});

server.on('error', error => {
  console.error(`Continuity Agent could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Continuity Agent is running at http://127.0.0.1:${port}`));
