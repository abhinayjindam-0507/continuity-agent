import { resolve } from 'node:path';
import { authorizeTool } from '../policy.mjs';
import { createFilesystemBroker } from './filesystem-broker.mjs';
import { createTerminalBroker } from './terminal-broker.mjs';

export { createFilesystemBroker } from './filesystem-broker.mjs';
export { createTerminalBroker } from './terminal-broker.mjs';

export function createToolBroker(projectRoot, config, brokerOptions = {}) {
  const root = resolve(projectRoot);
  const fsBroker = createFilesystemBroker({
    projectRoot: root,
    allowAbsolute: false,
    ...brokerOptions,
    authorizeWrite: async (details) => {
      const writeCall = {
        name: 'write_file',
        arguments: {
          path: details.path,
          content: details.content
        }
      };
      const policy = authorizeTool(writeCall, config);
      if (policy.decision === 'allowed') {
        return true;
      }
      return {
        approved: false,
        reason: policy.reason || 'Write operation denied by policy'
      };
    },
    authorizePatch: async (details) => {
      const patchCall = {
        name: 'patch_file',
        arguments: {
          path: details.path,
          patch: details.patch
        }
      };
      const policy = authorizeTool(patchCall, config);
      if (policy.decision === 'allowed') {
        return true;
      }
      return {
        approved: false,
        reason: policy.reason || 'Patch operation denied by policy'
      };
    }
  });

  const termBroker = createTerminalBroker({
    projectRoot: root,
    ...brokerOptions,
    allowedCommands: config.allowedCommands || []
  });

  async function execute(call, options = {}) {
    if (options?.signal?.aborted) {
      const abortErr = new Error('Tool execution aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const args = call.arguments || {};

    if (call.name === 'list_files') {
      const policy = authorizeTool(call, config);
      if (policy.decision !== 'allowed') {
        throw new Error(policy.reason || 'This tool action requires user approval.');
      }
      return fsBroker.listFiles(args.path || '.');
    }

    if (call.name === 'read_file') {
      const policy = authorizeTool(call, config);
      if (policy.decision !== 'allowed') {
        throw new Error(policy.reason || 'This tool action requires user approval.');
      }
      const result = await fsBroker.readFile(args.path);

      return {
        path: result.path,
        content: result.content.slice(0, 30_000)
      };
    }

    if (call.name === 'write_file') {
      if (typeof args.content !== 'string') {
        throw new Error('write_file requires text content.');
      }

      return fsBroker.writeFile(args.path, args.content, {
        authorizeWrite: options?.approvedMutationAuthorization
      });
    }

    if (call.name === 'patch_file') {
      const patchSpec = args.patch || {
        targetContent: args.targetContent,
        replacementContent: args.replacementContent
      };
      return fsBroker.patchFile(args.path, patchSpec, {
        authorizePatch: options?.approvedMutationAuthorization
      });
    }

    if (call.name === 'run_command') {
      const policy = authorizeTool(call, config);
      if (policy.decision !== 'allowed') {
        throw new Error(policy.reason || 'This tool action requires user approval.');
      }
      return termBroker.execute(args.command, args.args, options);
    }

    throw new Error(`Unknown tool: ${call.name}`);
  }

  return {
    execute,
    filesystemBroker: fsBroker,
    terminalBroker: termBroker
  };
}
