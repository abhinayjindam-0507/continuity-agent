import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { authorizeTool } from '../policy.mjs';
import { createFilesystemBroker } from './filesystem-broker.mjs';

export { createFilesystemBroker } from './filesystem-broker.mjs';

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

  function scopedPath(input = '.') {
    return fsBroker.resolvePath(input, { allowRoot: true }).absolutePath;
  }

  function safeCommand(command, args, allowed) {
    if (!allowed.includes(command)) {
      throw new Error(`Command '${command}' is not in the local allowlist.`);
    }

    if (
      !Array.isArray(args) ||
      args.some(
        arg => typeof arg !== 'string' || /[;&|`$<>]/.test(arg)
      )
    ) {
      throw new Error('Command arguments contain a blocked shell character.');
    }
  }

  function run(command, args) {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd: root,
        shell: false,
        timeout: 30_000,
        env: {
          ...process.env,
          NO_PROXY: '*',
          no_proxy: '*'
        }
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => {
        stdout += chunk;
      });

      child.stderr.on('data', chunk => {
        stderr += chunk;
      });

      child.on('error', rejectRun);

      child.on('close', code => {
        resolveRun({
          code,
          stdout: stdout.slice(0, 12_000),
          stderr: stderr.slice(0, 12_000)
        });
      });
    });
  }

  async function execute(call) {
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

      return fsBroker.writeFile(args.path, args.content);
    }

    if (call.name === 'patch_file') {
      const patchSpec = args.patch || {
        targetContent: args.targetContent,
        replacementContent: args.replacementContent
      };
      return fsBroker.patchFile(args.path, patchSpec);
    }

    if (call.name === 'run_command') {
      const policy = authorizeTool(call, config);
      if (policy.decision !== 'allowed') {
        throw new Error(policy.reason || 'This tool action requires user approval.');
      }
      safeCommand(args.command, args.args, config.allowedCommands);
      return run(args.command, args.args);
    }

    throw new Error(`Unknown tool: ${call.name}`);
  }

  return {
    execute,
    filesystemBroker: fsBroker
  };
}
