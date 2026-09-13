import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

// ── Hard resource limits ─────────────────────────────────────────────────────
export const DEFAULT_TIMEOUT = 30_000;         // 30 seconds
export const HARD_MAX_TIMEOUT = 120_000;       // 120 seconds

export const DEFAULT_STDOUT_LIMIT = 12_000;    // 12,000 characters
export const DEFAULT_STDERR_LIMIT = 12_000;    // 12,000 characters
export const HARD_MAX_OUTPUT = 50_000;         // 50,000 characters

// ── Shell metacharacters that must never appear in arguments ──────────────────
const BLOCKED_CHARS = /[;&|`$<>]/;

// ── Approved host environment variables ──────────────────────────────────────
export const DEFAULT_SAFE_ENV_VARS = Object.freeze([
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ'
]);

// ── Approved explicit environment variables ──────────────────────────────────
export const DEFAULT_SAFE_EXPLICIT_ENV_VARS = Object.freeze([
  'NODE_ENV',
  'PORT',
  'APP_PORT',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'CI',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP'
]);

// ── Dangerous/sensitive environment variable patterns ────────────────────────
export const BLOCKED_ENV_VARS = Object.freeze([
  // Node / runtime code execution hooks
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'RUBYOPT',
  'PERL5OPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',

  // Dynamic linker hijacking
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',

  // Shell / privilege escalation
  'SHELL',
  'IFS',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'SUDO_COMMAND',
  'SUDO_USER',
  'SUDO_UID',
  'SUDO_GID',

  // Cloud & credential secrets
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN'
]);

const DANGEROUS_KEY_PATTERN = /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|KEY|PRIVATE)/i;
const PROCESS_CONTROL_PATTERN = /^(?:LD_|DYLD_|NODE_OPT|PYTHON|RUBY|PERL|JAVA_TOOL)/i;

/**
 * Determines whether an environment variable name is considered dangerous
 * or sensitive (e.g. process control hooks, linker overrides, credentials).
 */
export function isDangerousEnvVar(key) {
  if (typeof key !== 'string') return true;
  const upper = key.toUpperCase();
  if (BLOCKED_ENV_VARS.includes(upper)) return true;
  if (PROCESS_CONTROL_PATTERN.test(upper)) return true;
  if (DANGEROUS_KEY_PATTERN.test(upper)) return true;
  return false;
}

/**
 * Validates that an explicit environment variable name is permitted:
 * - Must not be a dangerous/sensitive variable.
 * - Must be present in the approved allowlist (no arbitrary names allowed).
 */
export function isSafeExplicitEnvVar(key, allowedList = DEFAULT_SAFE_EXPLICIT_ENV_VARS) {
  if (typeof key !== 'string' || key.trim() === '') return false;
  if (isDangerousEnvVar(key)) return false;
  return allowedList.includes(key);
}

// ── Safe clamping ────────────────────────────────────────────────────────────
/**
 * Clamps a numeric bound to [minBound, maxBound], defaulting safely for
 * invalid inputs (undefined, non-number, non-integer, negative).
 *
 * Matches the filesystem-broker clampBound semantics.
 */
export function clampBound(value, defaultValue, maxBound, minBound = 1) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value)) return defaultValue;
  if (value < minBound) return defaultValue;
  if (value > maxBound) return maxBound;
  return value;
}

// ── Safe environment builder ─────────────────────────────────────────────────
/**
 * Constructs a minimal, safe environment for child processes.
 *
 * Security requirements:
 * - Never expose arbitrary host environment variables by default.
 * - Only copy explicitly approved host variables (DEFAULT_SAFE_ENV_VARS or allowedEnvVars).
 * - Explicit variables (opts.env/opts.environment) are restricted to an approved safe-variable
 *   allowlist mechanism (DEFAULT_SAFE_EXPLICIT_ENV_VARS or allowedExplicitEnvVars).
 * - Arbitrary and dangerous environment variable names (e.g. AWS_SECRET_ACCESS_KEY, NODE_OPTIONS)
 *   are rejected/ignored.
 * - Always set NO_PROXY='*' and no_proxy='*' to block network proxies.
 * - Callers of execute() cannot pass or override env.
 */
export function buildSafeEnvironment(opts = {}) {
  const safeEnv = {};

  // 1. Copy only explicitly approved variables from host process.env
  const approvedHostVars = Array.isArray(opts.allowedEnvVars)
    ? opts.allowedEnvVars
    : DEFAULT_SAFE_ENV_VARS;

  for (const key of approvedHostVars) {
    if (typeof key === 'string' && key in process.env) {
      safeEnv[key] = process.env[key];
    }
  }

  // Ensure a fallback PATH exists so standard commands can be located
  if (!safeEnv.PATH) {
    safeEnv.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  }

  // 2. Include explicitly configured variables from creation options (env or environment)
  // Must be restricted to an approved safe-variable mechanism; dangerous or arbitrary keys are ignored.
  const approvedExplicitVars = Array.isArray(opts.allowedExplicitEnvVars || opts.allowedEnvKeys)
    ? (opts.allowedExplicitEnvVars || opts.allowedEnvKeys)
    : DEFAULT_SAFE_EXPLICIT_ENV_VARS;

  const explicitEnv = opts.env || opts.environment;
  if (explicitEnv && typeof explicitEnv === 'object' && !Array.isArray(explicitEnv)) {
    for (const [key, value] of Object.entries(explicitEnv)) {
      if (typeof key === 'string' && typeof value === 'string') {
        if (isSafeExplicitEnvVar(key, approvedExplicitVars)) {
          safeEnv[key] = value;
        }
      }
    }
  }

  // 3. Always enforce proxy blocking (cannot be overridden)
  safeEnv.NO_PROXY = '*';
  safeEnv.no_proxy = '*';

  return Object.freeze(safeEnv);
}

// ── Terminal broker factory ──────────────────────────────────────────────────
/**
 * Creates a project-scoped terminal broker.
 *
 * Security invariants:
 * - cwd is always the resolved projectRoot; never caller-provided.
 * - shell is always false; never overridable.
 * - environment is minimal and safe; never exposes arbitrary host env vars.
 * - command must be an exact member of allowedCommands.
 * - every arg must be a string free of shell metacharacters.
 * - stdout/stderr are bounded during execution (streams drained without unbounded buffering).
 * - explicit timeout tracking: timedOut flag is set ONLY when timeout handler triggers.
 * - fail closed on any validation error; never silently retry.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot - absolute path used as cwd
 * @param {string[]} opts.allowedCommands - exact command allowlist
 * @param {number} [opts.timeout] - default execution timeout (ms)
 * @param {number} [opts.stdoutLimit] - default stdout bound (chars)
 * @param {number} [opts.stderrLimit] - default stderr bound (chars)
 * @param {object} [opts.env] - explicit safe environment variables
 * @param {object} [opts.environment] - alias for opts.env
 * @param {string[]} [opts.allowedEnvVars] - host environment variables allowed to be copied
 * @param {string[]} [opts.allowedExplicitEnvVars] - approved explicit environment variable keys
 */
export function createTerminalBroker(opts = {}) {
  if (!opts.projectRoot || typeof opts.projectRoot !== 'string') {
    throw new Error('Terminal broker requires a valid projectRoot.');
  }

  const resolvedRoot = resolve(opts.projectRoot);

  const allowedCommands = Array.isArray(opts.allowedCommands)
    ? [...opts.allowedCommands]
    : [];

  const defaultTimeout = clampBound(opts.timeout, DEFAULT_TIMEOUT, HARD_MAX_TIMEOUT);
  const defaultStdoutLimit = clampBound(opts.stdoutLimit, DEFAULT_STDOUT_LIMIT, HARD_MAX_OUTPUT);
  const defaultStderrLimit = clampBound(opts.stderrLimit, DEFAULT_STDERR_LIMIT, HARD_MAX_OUTPUT);

  // Pre-build the immutable safe environment at construction time
  const brokerEnv = buildSafeEnvironment(opts);

  // ── Validation helpers ──────────────────────────────────────────────────

  function validateCommand(command) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('Command must be a non-empty string.');
    }
    if (!allowedCommands.includes(command)) {
      throw new Error(`Command '${command}' is not in the local allowlist.`);
    }
  }

  function validateArgs(args) {
    if (!Array.isArray(args)) {
      throw new Error('Command arguments must be an array.');
    }
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error('Every command argument must be a string.');
      }
      if (BLOCKED_CHARS.test(arg)) {
        throw new Error('Command arguments contain a blocked shell character.');
      }
    }
  }

  // ── Execute ─────────────────────────────────────────────────────────────

  /**
   * Execute a command within the project root.
   *
   * @param {string} command - the binary to run (must be in allowedCommands)
   * @param {string[]} args - arguments to pass (must all be safe strings)
   * @param {object} [callOpts] - per-call overrides (bounded by hard maximums)
   * @param {number} [callOpts.timeout] - execution timeout (ms)
   * @param {number} [callOpts.stdoutLimit] - stdout bound (chars)
   * @param {number} [callOpts.stderrLimit] - stderr bound (chars)
   * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>}
   */
  function execute(command, args, callOpts = {}) {
    validateCommand(command);
    validateArgs(args);

    const timeout = clampBound(callOpts.timeout, defaultTimeout, HARD_MAX_TIMEOUT);
    const stdoutLimit = clampBound(callOpts.stdoutLimit, defaultStdoutLimit, HARD_MAX_OUTPUT);
    const stderrLimit = clampBound(callOpts.stderrLimit, defaultStderrLimit, HARD_MAX_OUTPUT);

    return new Promise((resolveRun, rejectRun) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd: resolvedRoot,
          shell: false,
          // Environment is fixed to the broker's safe environment;
          // callOpts.env or callOpts.environment is deliberately ignored.
          env: brokerEnv
        });
      } catch (err) {
        return rejectRun(err);
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer = null;

      // Explicit timeout handling:
      // We manage our own timer rather than relying on spawn's built-in timeout,
      // so timedOut is set to true ONLY when our explicit timeout handler fires.
      // An external SIGTERM or self-termination will not set timedOut = true.
      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // Process may already have terminated
          }
        }, timeout);

        if (timer.unref) {
          timer.unref();
        }
      }

      function cleanupTimer() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }

      // Bound output during execution:
      // Accumulate at most stdoutLimit characters.
      // Continue consuming and discarding subsequent chunks to drain the pipe so
      // child does not block on a full pipe buffer.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (stdout.length < stdoutLimit) {
          const remaining = stdoutLimit - stdout.length;
          stdout += chunk.slice(0, remaining);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        if (stderr.length < stderrLimit) {
          const remaining = stderrLimit - stderr.length;
          stderr += chunk.slice(0, remaining);
        }
      });

      child.on('error', err => {
        cleanupTimer();
        rejectRun(err);
      });

      child.on('close', (code, signal) => {
        cleanupTimer();

        resolveRun({
          code,
          signal,
          stdout: stdout.slice(0, stdoutLimit),
          stderr: stderr.slice(0, stderrLimit),
          timedOut
        });
      });
    });
  }

  // ── Public surface ──────────────────────────────────────────────────────

  return Object.freeze({
    execute,

    /** The resolved project root used as cwd. Read-only. */
    get projectRoot() { return resolvedRoot; },

    /** The command allowlist snapshot. Read-only. */
    get allowedCommands() { return [...allowedCommands]; },

    /** Effective default timeout (ms). Read-only. */
    get timeout() { return defaultTimeout; },

    /** Effective default stdout limit (chars). Read-only. */
    get stdoutLimit() { return defaultStdoutLimit; },

    /** Effective default stderr limit (chars). Read-only. */
    get stderrLimit() { return defaultStderrLimit; },

    /** Hard maximum timeout (ms). Read-only. */
    get hardMaxTimeout() { return HARD_MAX_TIMEOUT; },

    /** Hard maximum output bound (chars). Read-only. */
    get hardMaxOutput() { return HARD_MAX_OUTPUT; },

    /** The minimal safe environment used for child processes. Read-only snapshot. */
    get environment() { return { ...brokerEnv }; },

    /** Alias for environment. Read-only snapshot. */
    get env() { return { ...brokerEnv }; }
  });
}
