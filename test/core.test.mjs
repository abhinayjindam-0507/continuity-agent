import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTransition, isTerminal } from '../src/task-state.mjs';
import { authorizeTool } from '../src/policy.mjs';

test('task lifecycle permits safe resume but blocks terminal restart', () => {
  assert.doesNotThrow(() => assertTransition('paused', 'queued'));
  assert.throws(() => assertTransition('completed', 'running'), /Invalid task transition/);
  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('running'), false);
});

test('policy permits only low-risk reads and allowlisted commands', () => {
  assert.equal(authorizeTool({ name: 'read_file' }, {}).decision, 'allowed');
  assert.equal(authorizeTool({ name: 'run_command', arguments: { command: 'npm' } }, { allowedCommands: ['npm'] }).decision, 'allowed');
  assert.equal(authorizeTool({ name: 'run_command', arguments: { command: 'rm' } }, { allowedCommands: ['npm'] }).decision, 'denied');
});

test('file changes always require an explicit approval flow', () => {
  assert.equal(authorizeTool({ name: 'write_file' }, { allowWrites: false }).decision, 'denied');
  assert.equal(authorizeTool({ name: 'write_file' }, { allowWrites: true }).decision, 'requires_approval');
});
