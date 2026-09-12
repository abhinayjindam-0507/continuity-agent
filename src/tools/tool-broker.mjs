import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { authorizeTool } from '../policy.mjs';

export function createToolBroker(projectRoot, config) {
  const root = resolve(projectRoot);

  function scopedPath(input = '.') {
    const target = resolve(root, input);

    if (target !== root && !target.startsWith(root + '/')) {
      throw new Error('Path is outside the approved project folder.');
    }

    return target;
  }

  async function filesUnder(directory, limit = 160) {
    const output = [];

    async function walk(current) {
      if (output.length >= limit) return;

      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === '.continuity-agent'
        ) {
          continue;
        }

        const absolute = join(current, entry.name);

        if (entry.isDirectory()) {
          await walk(absolute);
        } else {
          output.push(relative(root, absolute));
        }

        if (output.length >= limit) return;
      }
    }

    await walk(directory);
    return output;
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
    const policy = authorizeTool(call, config);

    if (policy.decision !== 'allowed') {
      throw new Error(
        policy.reason || 'This tool action requires user approval.'
      );
    }

    if (call.name === 'list_files') {
      return {
        files: await filesUnder(scopedPath(args.path || '.'))
      };
    }

    if (call.name === 'read_file') {
      const file = scopedPath(args.path);

      return {
        path: relative(root, file),
        content: (await readFile(file, 'utf8')).slice(0, 30_000)
      };
    }

    if (call.name === 'write_file') {
      const file = scopedPath(args.path);

      if (typeof args.content !== 'string') {
        throw new Error('write_file requires text content.');
      }

      const oldContent = existsSync(file)
        ? await readFile(file, 'utf8')
        : '';

      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, args.content);

      return {
        path: relative(root, file),
        changed: oldContent !== args.content,
        previousBytes: oldContent.length,
        newBytes: args.content.length
      };
    }

    if (call.name === 'run_command') {
      safeCommand(args.command, args.args, config.allowedCommands);
      return run(args.command, args.args);
    }

    throw new Error(`Unknown tool: ${call.name}`);
  }

  return {
    execute
  };
}
