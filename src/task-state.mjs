const transitions = {
  draft: ['queued'],
  queued: ['planning', 'running', 'needs_setup', 'paused'],
  planning: ['running', 'paused', 'failed'],
  running: ['awaiting_approval', 'switching_model', 'paused', 'completed', 'failed'],
  awaiting_approval: ['running', 'paused'],
  switching_model: ['validating_handoff', 'paused'],
  validating_handoff: ['running', 'paused'],
  needs_setup: ['queued', 'paused'],
  paused: ['queued', 'failed'],
  completed: [],
  failed: []
};

export function assertTransition(previous, next) {
  if (previous === next || transitions[previous]?.includes(next)) return;
  throw new Error(`Invalid task transition: ${previous} → ${next}`);
}

export function transition(previous, next) {
  assertTransition(previous, next);
  return next;
}

export function transitionTask(task, next) {
  assertTransition(task.status, next);
  task.status = next;
  return task;
}

export function isTerminal(status) {
  return status === 'completed' || status === 'failed';
}
