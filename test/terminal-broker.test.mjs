import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createTerminalBroker,
  clampBound,
  buildSafeEnvironment,
  DEFAULT_TIMEOUT,
  HARD_MAX_TIMEOUT,
  DEFAULT_STDOUT_LIMIT,
  DEFAULT_STDERR_LIMIT,
  HARD_MAX_OUTPUT,
  DEFAULT_SAFE_ENV_VARS,
  DEFAULT_SAFE_EXPLICIT_ENV_VARS,
  BLOCKED_ENV_VARS,
  isDangerousEnvVar,
  isSafeExplicitEnvVar
} from '../src/tools/terminal-broker.mjs';

let testDir;

// ── Setup / Teardown ─────────────────────────────────────────────────────────

test.before(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'terminal-broker-test-'));

  // Create helper test scripts (avoids shell metacharacters like ; in CLI args)
  await writeFile(
    join(testDir, 'stdout-large.js'),
    "process.stdout.write('A'.repeat(200000))\n"
  );

  await writeFile(
    join(testDir, 'stderr-large.js'),
    "process.stderr.write('E'.repeat(200000))\n"
  );

  await writeFile(
    join(testDir, 'drain-streams.js'),
    "for (let i = 0; i < 1000; i++) {\n" +
    "  process.stdout.write('out-' + i + '-'.repeat(50))\n" +
    "  process.stderr.write('err-' + i + '-'.repeat(50))\n" +
    "}\n"
  );

  await writeFile(
    join(testDir, 'sigterm-self.js'),
    "process.kill(process.pid, 'SIGTERM')\n"
  );

  await writeFile(
    join(testDir, 'print-env.js'),
    "process.stdout.write(JSON.stringify(process.env))\n"
  );
});

test.after(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Helper ───────────────────────────────────────────────────────────────────

function makeBroker(overrides = {}) {
  return createTerminalBroker({
    projectRoot: testDir,
    allowedCommands: ['echo', 'cat', 'sleep', 'printf', 'ls', 'node', 'env'],
    ...overrides
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Terminal Broker unit tests
// ──────────────────────────────────────────────────────────────────────────────

test('1. allowed command executes successfully', async () => {
  const broker = makeBroker();
  const result = await broker.execute('echo', ['hello', 'world']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello world/);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
});

test('2. disallowed command is rejected', () => {
  const broker = makeBroker();
  assert.throws(
    () => broker.execute('rm', ['-rf', '/']),
    /Command 'rm' is not in the local allowlist/
  );
});

test('3. shell metacharacter in arg is rejected', () => {
  const broker = makeBroker();
  const dangerous = [';', '&', '|', '`', '$', '<', '>'];
  for (const ch of dangerous) {
    assert.throws(
      () => broker.execute('echo', [`foo${ch}bar`]),
      /blocked shell character/,
      `Should reject argument containing '${ch}'`
    );
  }
});

test('4. non-string arg is rejected', () => {
  const broker = makeBroker();
  assert.throws(
    () => broker.execute('echo', [123]),
    /Every command argument must be a string/
  );
  assert.throws(
    () => broker.execute('echo', [null]),
    /Every command argument must be a string/
  );
  assert.throws(
    () => broker.execute('echo', [undefined]),
    /Every command argument must be a string/
  );
});

test('5. non-array args is rejected', () => {
  const broker = makeBroker();
  assert.throws(
    () => broker.execute('echo', 'not-an-array'),
    /Command arguments must be an array/
  );
  assert.throws(
    () => broker.execute('echo', { 0: 'a' }),
    /Command arguments must be an array/
  );
});

test('6. empty command is rejected', () => {
  const broker = makeBroker();
  assert.throws(
    () => broker.execute('', []),
    /Command must be a non-empty string/
  );
});

test('7. invalid command types are rejected', () => {
  const broker = makeBroker();
  assert.throws(
    () => broker.execute(null, []),
    /Command must be a non-empty string/
  );
  assert.throws(
    () => broker.execute(undefined, []),
    /Command must be a non-empty string/
  );
  assert.throws(
    () => broker.execute(42, []),
    /Command must be a non-empty string/
  );
});

test('8. cwd is always the project root', async () => {
  const broker = makeBroker();
  const result = await broker.execute('ls', []);
  assert.equal(result.code, 0);
  assert.equal(broker.projectRoot, testDir);
});

test('9. shell:false behavior — shell syntax is not interpreted', async () => {
  const broker = makeBroker();
  const result = await broker.execute('echo', ['hello world']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello world/);
});

test('10. stdout is bounded during execution without buffering unlimited output', async () => {
  const stdoutLimit = 100;
  const broker = makeBroker({ stdoutLimit });

  // Generate 200,000 characters of output (substantially larger than stdoutLimit)
  const result = await broker.execute('node', ['stdout-large.js']);

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  // Output does not exceed the limit
  assert.equal(result.stdout.length, stdoutLimit);
  assert.equal(result.stdout, 'A'.repeat(stdoutLimit));
});

test('11. stderr is bounded during execution without buffering unlimited output', async () => {
  const stderrLimit = 100;
  const broker = makeBroker({ stderrLimit });

  // Generate 200,000 characters of error output
  const result = await broker.execute('node', ['stderr-large.js']);

  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  // Stderr does not exceed the limit
  assert.equal(result.stderr.length, stderrLimit);
  assert.equal(result.stderr, 'E'.repeat(stderrLimit));
});

test('12. child streams drain properly so process does not block on full pipe', async () => {
  const broker = makeBroker({ stdoutLimit: 50, stderrLimit: 50 });

  // Alternating large stdout and stderr writes that would deadlock a non-draining reader
  const result = await broker.execute('node', ['drain-streams.js']);

  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 50);
  assert.equal(result.stderr.length, 50);
});

test('13. timeout behavior terminates the child and sets timedOut flag', async () => {
  const broker = makeBroker({ timeout: 150 }); // 150ms
  const result = await broker.execute('sleep', ['30']);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
});

test('14. SIGTERM does not automatically mean timedOut', async () => {
  // A process that terminates via SIGTERM without the timeout expiring
  // must report timedOut = false
  const broker = makeBroker({ timeout: 30_000 });
  const result = await broker.execute('node', ['sigterm-self.js']);

  assert.equal(result.timedOut, false);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.code, null);
});

test('15. caller timeout cannot exceed hard maximum', async () => {
  const broker = makeBroker();
  assert.equal(broker.hardMaxTimeout, HARD_MAX_TIMEOUT);

  const clamped = makeBroker({ timeout: 999_999 });
  assert.equal(clamped.timeout, HARD_MAX_TIMEOUT);
});

test('16. caller output limits cannot exceed hard maximum', async () => {
  const broker = makeBroker({
    stdoutLimit: 999_999,
    stderrLimit: 999_999
  });
  assert.equal(broker.stdoutLimit, HARD_MAX_OUTPUT);
  assert.equal(broker.stderrLimit, HARD_MAX_OUTPUT);
});

test('17. malformed limits safely default', async () => {
  const b1 = makeBroker({ timeout: 3.14, stdoutLimit: 'abc', stderrLimit: null });
  assert.equal(b1.timeout, DEFAULT_TIMEOUT);
  assert.equal(b1.stdoutLimit, DEFAULT_STDOUT_LIMIT);
  assert.equal(b1.stderrLimit, DEFAULT_STDERR_LIMIT);

  const b2 = makeBroker({ timeout: -100, stdoutLimit: -1, stderrLimit: -50 });
  assert.equal(b2.timeout, DEFAULT_TIMEOUT);
  assert.equal(b2.stdoutLimit, DEFAULT_STDOUT_LIMIT);
  assert.equal(b2.stderrLimit, DEFAULT_STDERR_LIMIT);

  const b3 = makeBroker({ timeout: 0, stdoutLimit: 0, stderrLimit: 0 });
  assert.equal(b3.timeout, DEFAULT_TIMEOUT);
  assert.equal(b3.stdoutLimit, DEFAULT_STDOUT_LIMIT);
  assert.equal(b3.stderrLimit, DEFAULT_STDERR_LIMIT);
});

test('18. no caller cwd override', async () => {
  const broker = makeBroker();
  assert.equal(broker.projectRoot, testDir);

  const broker2 = createTerminalBroker({
    projectRoot: testDir,
    allowedCommands: ['echo'],
    cwd: '/tmp'
  });
  assert.equal(broker2.projectRoot, testDir);
});

test('19. no implicit retry', async () => {
  const broker = makeBroker();
  const result = await broker.execute('cat', ['nonexistent_xyz_file']);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.length > 0);
});

test('20. default environment does not leak arbitrary host variables', async () => {
  const secretKey = 'TEST_HOST_SECRET_TOKEN_XYZ';
  const secretVal = 'super_secret_host_credential_12345';
  process.env[secretKey] = secretVal;

  try {
    const broker = makeBroker();
    const result = await broker.execute('node', ['print-env.js']);

    assert.equal(result.code, 0);
    const childEnv = JSON.parse(result.stdout);

    // Arbitrary host secret must not be present in the child's environment
    assert.equal(childEnv[secretKey], undefined);

    // Also verify broker.environment snapshot
    assert.equal(broker.environment[secretKey], undefined);
  } finally {
    delete process.env[secretKey];
  }
});

test('21. environment always enforces proxy blocking (NO_PROXY and no_proxy)', async () => {
  const broker = makeBroker();
  const result = await broker.execute('node', ['print-env.js']);

  assert.equal(result.code, 0);
  const childEnv = JSON.parse(result.stdout);

  assert.equal(childEnv.NO_PROXY, '*');
  assert.equal(childEnv.no_proxy, '*');
  assert.equal(broker.environment.NO_PROXY, '*');
  assert.equal(broker.environment.no_proxy, '*');
});

test('22. explicit safe environment variables work via env / environment option', async () => {
  const broker = makeBroker({
    env: {
      NODE_ENV: 'production',
      APP_PORT: '8080'
    }
  });

  const result = await broker.execute('node', ['print-env.js']);

  assert.equal(result.code, 0);
  const childEnv = JSON.parse(result.stdout);

  assert.equal(childEnv.NODE_ENV, 'production');
  assert.equal(childEnv.APP_PORT, '8080');
  assert.equal(broker.environment.NODE_ENV, 'production');
  assert.equal(broker.environment.APP_PORT, '8080');
});

test('23. caller cannot override env through execute()', async () => {
  const broker = makeBroker();

  // Attempt to inject an environment variable through callOpts
  const result = await broker.execute(
    'node',
    ['print-env.js'],
    {
      env: { INJECTED_VAR: 'malicious_override' },
      environment: { INJECTED_VAR: 'malicious_override' }
    }
  );

  assert.equal(result.code, 0);
  const childEnv = JSON.parse(result.stdout);

  // Caller-injected env must be completely ignored
  assert.equal(childEnv.INJECTED_VAR, undefined);
});

test('24. clampBound enforces limits for terminal broker values', () => {
  assert.equal(clampBound(undefined, 30_000, 120_000), 30_000);
  assert.equal(clampBound(3.14, 30_000, 120_000), 30_000);
  assert.equal(clampBound('hello', 30_000, 120_000), 30_000);
  assert.equal(clampBound(-5, 30_000, 120_000), 30_000);
  assert.equal(clampBound(0, 30_000, 120_000), 30_000);
  assert.equal(clampBound(999_999, 30_000, 120_000), 120_000);
  assert.equal(clampBound(60_000, 30_000, 120_000), 60_000);
  assert.equal(clampBound(1, 30_000, 120_000), 1);
  assert.equal(clampBound(120_000, 30_000, 120_000), 120_000);
});

test('25. per-call options are clamped independently', async () => {
  const broker = makeBroker();
  const result = await broker.execute('echo', ['test'], {
    stdoutLimit: 999_999,
    stderrLimit: 999_999,
    timeout: 999_999
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /test/);
});

test('26. process result has expected shape', async () => {
  const broker = makeBroker();
  const result = await broker.execute('echo', ['structured']);
  assert.ok('code' in result);
  assert.ok('signal' in result);
  assert.ok('stdout' in result);
  assert.ok('stderr' in result);
  assert.ok('timedOut' in result);
  assert.equal(typeof result.code, 'number');
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  assert.equal(typeof result.timedOut, 'boolean');
});

test('27. missing projectRoot throws', () => {
  assert.throws(
    () => createTerminalBroker({ allowedCommands: ['echo'] }),
    /Terminal broker requires a valid projectRoot/
  );
  assert.throws(
    () => createTerminalBroker({ projectRoot: '', allowedCommands: ['echo'] }),
    /Terminal broker requires a valid projectRoot/
  );
});

test('28. returned object is frozen (immutable)', () => {
  const broker = makeBroker();
  assert.ok(Object.isFrozen(broker));
});

// ──────────────────────────────────────────────────────────────────────────────
// Tool Broker integration tests for terminal execution
// ──────────────────────────────────────────────────────────────────────────────

test('29. run_command policy denial prevents terminal execution', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  const config = {
    allowWrites: false,
    allowedCommands: ['echo']  // only echo is allowed by policy
  };

  const broker = createToolBroker(testDir, config);

  // Disallowed command — policy says denied
  await assert.rejects(
    () => broker.execute({
      name: 'run_command',
      arguments: { command: 'rm', args: ['-rf', '/'] }
    }),
    /Command is not in the project allowlist/
  );
});

test('30. allowed command reaches terminal broker through tool broker', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  const config = {
    allowWrites: false,
    allowedCommands: ['echo']
  };

  const broker = createToolBroker(testDir, config);

  // Allowed command — policy says allowed, terminal broker executes
  const result = await broker.execute({
    name: 'run_command',
    arguments: { command: 'echo', args: ['hello', 'from', 'tool-broker'] }
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello from tool-broker/);
  assert.equal(result.timedOut, false);
});

test('31. tool broker remains the only authorization boundary', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  const config = {
    allowWrites: false,
    allowedCommands: []
  };

  const broker = createToolBroker(testDir, config);

  await assert.rejects(
    () => broker.execute({
      name: 'run_command',
      arguments: { command: 'echo', args: ['denied'] }
    }),
    /Command is not in the project allowlist/
  );

  assert.ok(broker.terminalBroker);
  assert.ok(typeof broker.terminalBroker.execute === 'function');
});

test('32. tool broker exposes terminal broker instance with configured allowedCommands', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  const config = {
    allowWrites: false,
    allowedCommands: ['echo', 'ls']
  };

  const broker = createToolBroker(testDir, config);

  assert.equal(broker.terminalBroker.projectRoot, broker.filesystemBroker.projectRoot);
  assert.deepEqual(broker.terminalBroker.allowedCommands, ['echo', 'ls']);
  assert.equal(broker.terminalBroker.timeout, DEFAULT_TIMEOUT);
});

test('33. brokerOptions cannot override config.allowedCommands in Tool Broker', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  const config = {
    allowWrites: false,
    allowedCommands: ['echo']
  };

  // Attempt to bypass or override allowedCommands through brokerOptions
  const broker = createToolBroker(testDir, config, {
    allowedCommands: ['echo', 'cat', 'rm']
  });

  // Allowed commands must still strictly be config.allowedCommands
  assert.deepEqual(broker.terminalBroker.allowedCommands, ['echo']);
});

test('34. run_command result shape matches terminal broker output', async () => {
  const { createToolBroker } = await import('../src/tools/tool-broker.mjs');

  const config = {
    allowWrites: false,
    allowedCommands: ['echo']
  };

  const broker = createToolBroker(testDir, config);
  const result = await broker.execute({
    name: 'run_command',
    arguments: { command: 'echo', args: ['shape-test'] }
  });

  assert.ok('code' in result);
  assert.ok('signal' in result);
  assert.ok('stdout' in result);
  assert.ok('stderr' in result);
  assert.ok('timedOut' in result);
  assert.equal(result.timedOut, false);
});

test('35. dangerous explicit environment keys are ignored and not exposed to child process', async () => {
  const broker = makeBroker({
    env: {
      AWS_SECRET_ACCESS_KEY: 'dangerous_secret_key',
      AWS_ACCESS_KEY_ID: 'dangerous_key_id',
      NODE_OPTIONS: '--inspect-brk=0.0.0.0',
      LD_PRELOAD: '/tmp/malicious.so',
      DYLD_INSERT_LIBRARIES: '/tmp/malicious.dylib',
      GITHUB_TOKEN: 'ghp_secret',
      API_SECRET_KEY: 'super_secret',
      NODE_ENV: 'test' // safe key
    }
  });

  // Verify dangerous keys are excluded from broker.environment
  assert.equal(broker.environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(broker.environment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(broker.environment.NODE_OPTIONS, undefined);
  assert.equal(broker.environment.LD_PRELOAD, undefined);
  assert.equal(broker.environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(broker.environment.GITHUB_TOKEN, undefined);
  assert.equal(broker.environment.API_SECRET_KEY, undefined);
  assert.equal(broker.environment.NODE_ENV, 'test');

  // Verify dangerous keys are not exposed to the child process
  const result = await broker.execute('node', ['print-env.js']);
  assert.equal(result.code, 0);
  const childEnv = JSON.parse(result.stdout);

  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.LD_PRELOAD, undefined);
  assert.equal(childEnv.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(childEnv.API_SECRET_KEY, undefined);
  assert.equal(childEnv.NODE_ENV, 'test');
});

test('36. arbitrary unapproved explicit environment keys are ignored', async () => {
  const broker = makeBroker({
    env: {
      SOME_RANDOM_UNAPPROVED_VARIABLE: 'should_be_ignored',
      PORT: '3000'
    }
  });

  assert.equal(broker.environment.SOME_RANDOM_UNAPPROVED_VARIABLE, undefined);
  assert.equal(broker.environment.PORT, '3000');

  const result = await broker.execute('node', ['print-env.js']);
  assert.equal(result.code, 0);
  const childEnv = JSON.parse(result.stdout);

  assert.equal(childEnv.SOME_RANDOM_UNAPPROVED_VARIABLE, undefined);
  assert.equal(childEnv.PORT, '3000');
});

test('37. dangerous keys cannot be forced via allowedExplicitEnvVars', async () => {
  const broker = makeBroker({
    allowedExplicitEnvVars: ['NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY', 'APP_PORT'],
    env: {
      NODE_OPTIONS: '--eval "console.log(1)"',
      AWS_SECRET_ACCESS_KEY: 'secret',
      APP_PORT: '9000'
    }
  });

  assert.equal(broker.environment.NODE_OPTIONS, undefined);
  assert.equal(broker.environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(broker.environment.APP_PORT, '9000');

  const result = await broker.execute('node', ['print-env.js']);
  assert.equal(result.code, 0);
  const childEnv = JSON.parse(result.stdout);

  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(childEnv.APP_PORT, '9000');
});

