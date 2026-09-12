export function authorizeTool(call, config) {
  const name = call.name;
  if (name === 'list_files' || name === 'read_file') return { decision: 'allowed', risk: 'low' };
  if (name === 'write_file') {
    return config.allowWrites
      ? { decision: 'requires_approval', risk: 'high', reason: 'File changes require an explicit, parameter-bound approval flow.' }
      : { decision: 'denied', risk: 'high', reason: 'File writes are disabled by local policy.' };
  }
  if (name === 'run_command') {
    const command = call.arguments?.command;
    return config.allowedCommands.includes(command)
      ? { decision: 'allowed', risk: 'medium' }
      : { decision: 'denied', risk: 'high', reason: 'Command is not in the project allowlist.' };
  }
  return { decision: 'denied', risk: 'high', reason: 'Unknown tool capability.' };
}
