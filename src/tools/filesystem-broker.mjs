import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path';

export const DEFAULT_MAX_FILE_SIZE = 256 * 1024; // 256 KB
export const HARD_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB hard limit

export const DEFAULT_MAX_ENTRIES = 160;
export const HARD_MAX_ENTRIES = 1000; // 1,000 entries hard limit

/**
 * Clamps a numeric bound to [minBound, maxBound], defaulting safely for invalid inputs.
 *
 * Rules:
 * - undefined, non-number, non-integer -> defaultValue
 * - negative / less than minBound -> defaultValue
 * - greater than maxBound -> maxBound
 * - valid value in [minBound, maxBound] -> value
 */
export function clampBound(value, defaultValue, maxBound, minBound = 0) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return defaultValue;
  }
  if (value < minBound) {
    return defaultValue;
  }
  if (value > maxBound) {
    return maxBound;
  }
  return value;
}

export const DEFAULT_SENSITIVE_DIRECTORIES = Object.freeze([
  '.git',
  '.continuity-agent',
  'node_modules',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.config'
]);

export const DEFAULT_SENSITIVE_FILES = Object.freeze([
  '.env',
  '.git-credentials',
  '.npmrc',
  '.netrc',
  'credentials.json',
  'token.json',
  'secret.json',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  'id_ecdsa'
]);

export const DEFAULT_SENSITIVE_EXTENSIONS = Object.freeze([
  '.pem',
  '.key',
  '.pfx',
  '.p12',
  '.pkcs12'
]);

/**
 * TOCTOU (Time-Of-Check to Time-Of-Use) Assessment & Mitigations:
 *
 * Potential threat:
 * An attacker process running concurrently on the host filesystem could swap a validated
 * project path with a symlink pointing outside the project root between the initial
 * validation step and the actual filesystem read/write/patch operation.
 *
 * Mitigation in place:
 * 1. Pre-operation scoping & canonical realpath validation: checks target and existing
 *    ancestors against both resolvedRoot and canonicalRoot.
 * 2. Sensitive path & file-type enforcement before invoking authorization or operations.
 * 3. Canonical symlink check in directory listing: verifies symlink targets against
 *    both canonicalRoot and resolvedRoot.
 * 4. Post-operation invariant verification: after reading, writing, or patching, the
 *    broker immediately re-resolves realpathSync to ensure the target did not escape
 *    the project root during the operation window.
 *
 * Limitation & Residual Risk:
 * Node.js cross-platform fs APIs do not expose atomic Linux openat2(2) RESOLVE_BENEATH
 * syscalls. In a hostile multi-user environment where an untrusted local user has concurrent
 * write access to the project directory, true kernel-level race prevention requires OS-level
 * sandbox isolation (e.g. mount namespaces, chroot, or container boundaries). For single-user
 * and local-first Continuity Agent deployments, the pre-check + post-operation invariant
 * verification provides the strongest practical cross-platform defense without native C++ addons.
 */
export function createFilesystemBroker({
  projectRoot,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  maxEntries = DEFAULT_MAX_ENTRIES,
  sensitiveDirectories = DEFAULT_SENSITIVE_DIRECTORIES,
  sensitiveFiles = DEFAULT_SENSITIVE_FILES,
  sensitiveExtensions = DEFAULT_SENSITIVE_EXTENSIONS,
  sensitivePatterns = [],
  allowAbsolute = false,
  authorizeWrite = null,
  authorizePatch = null
} = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('projectRoot must be a non-empty string.');
  }

  const effectiveMaxFileSize = clampBound(
    maxFileSize,
    DEFAULT_MAX_FILE_SIZE,
    HARD_MAX_FILE_SIZE,
    1
  );

  const effectiveMaxEntries = clampBound(
    maxEntries,
    DEFAULT_MAX_ENTRIES,
    HARD_MAX_ENTRIES,
    1
  );

  const resolvedRoot = resolve(projectRoot);
  let canonicalRoot = resolvedRoot;
  if (existsSync(resolvedRoot)) {
    try {
      canonicalRoot = realpathSync(resolvedRoot);
    } catch {
      canonicalRoot = resolvedRoot;
    }
  }

  function isPathInside(childPath, parentPath) {
    return childPath === parentPath || childPath.startsWith(parentPath + sep);
  }

  const sensDirs = [...sensitiveDirectories].map(d => d.toLowerCase());
  const sensFiles = [...sensitiveFiles].map(f => f.toLowerCase());
  const sensExts = [...sensitiveExtensions].map(e => e.toLowerCase());

  function isSensitive(relPath, fileName) {
    if (!relPath || relPath === '.') return false;

    const normalized = relPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const base = (fileName || parts[parts.length - 1] || '').toLowerCase();

    // Check directory parts
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (sensDirs.includes(parts[i].toLowerCase())) {
        return true;
      }
    }

    // Check if the target itself is a sensitive directory name
    if (sensDirs.includes(base)) {
      return true;
    }

    // Check .env variants
    if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env_')) {
      return true;
    }

    // Check sensitive file names and prefixes (e.g. id_rsa*)
    for (const sf of sensFiles) {
      if (base === sf) {
        return true;
      }
      if (sf.startsWith('id_') && base.startsWith(sf)) {
        return true;
      }
    }

    // Check sensitive file extensions (.key, .pem, etc.)
    const ext = extname(base).toLowerCase();
    if (ext && sensExts.includes(ext)) {
      return true;
    }

    // Check custom patterns
    for (const pattern of sensitivePatterns) {
      if (pattern instanceof RegExp && pattern.test(normalized)) {
        return true;
      }
      if (typeof pattern === 'string' && (normalized === pattern || base === pattern.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  function resolveScopedPath(inputPath, options = {}) {
    if (typeof inputPath !== 'string') {
      throw new TypeError('Invalid path: path must be a string.');
    }

    if (inputPath.includes('\0')) {
      throw new Error('Invalid path: null bytes are not permitted.');
    }

    const trimmed = inputPath.trim();
    if (trimmed === '') {
      if (options.allowRoot) {
        return {
          absolutePath: resolvedRoot,
          relativePath: '.'
        };
      }
      throw new Error('Invalid path: path cannot be empty.');
    }

    const permitAbsolute = options.allowAbsolute ?? allowAbsolute;
    const isAbs = isAbsolute(inputPath);

    if (isAbs) {
      if (!permitAbsolute) {
        throw new Error(
          `Absolute paths are not permitted in project-scoped access: '${inputPath}'. Use a path relative to the project root.`
        );
      }

      const absoluteTarget = resolve(inputPath);
      if (
        !isPathInside(absoluteTarget, resolvedRoot) &&
        !isPathInside(absoluteTarget, canonicalRoot)
      ) {
        throw new Error(
          `Path escapes approved project root: '${inputPath}'.`
        );
      }
    }

    const target = resolve(resolvedRoot, inputPath);

    // Boundary check: must be inside root or canonical root
    if (
      !isPathInside(target, resolvedRoot) &&
      !isPathInside(target, canonicalRoot)
    ) {
      throw new Error(
        `Path traversal detected: path escapes approved project root ('${inputPath}').`
      );
    }

    const rel = relative(resolvedRoot, target);
    const normalizedRel = rel === '' ? '.' : rel.replace(/\\/g, '/');

    if (!options.skipSensitiveCheck && isSensitive(normalizedRel, basename(target))) {
      throw new Error(
        `Access to sensitive file or directory is blocked: '${normalizedRel}'.`
      );
    }

    // Symlink escape check for existing targets
    if (existsSync(target)) {
      try {
        const real = realpathSync(target);
        if (
          !isPathInside(real, canonicalRoot) &&
          !isPathInside(real, resolvedRoot)
        ) {
          throw new Error(
            `Symlink traversal detected: path resolves outside approved project root ('${inputPath}').`
          );
        }
      } catch (err) {
        if (err.message.includes('Symlink traversal')) throw err;
      }
    } else {
      // For non-existent files (e.g. pending write), check existing ancestor directories
      let ancestor = dirname(target);
      while (
        ancestor !== resolvedRoot &&
        ancestor !== canonicalRoot &&
        !existsSync(ancestor)
      ) {
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (existsSync(ancestor)) {
        try {
          const realAncestor = realpathSync(ancestor);
          if (
            !isPathInside(realAncestor, canonicalRoot) &&
            !isPathInside(realAncestor, resolvedRoot)
          ) {
            throw new Error(
              `Symlink traversal detected: parent directory resolves outside approved project root ('${inputPath}').`
            );
          }
        } catch (err) {
          if (err.message.includes('Symlink traversal')) throw err;
        }
      }
    }

    return {
      absolutePath: target,
      relativePath: normalizedRel
    };
  }

  async function checkAuthorization(actionDetails, callOpts = {}) {
    const hook =
      actionDetails.operation === 'patch'
        ? (callOpts.authorizePatch || callOpts.authorizeWrite || authorizePatch || authorizeWrite)
        : (callOpts.authorizeWrite || authorizeWrite);

    if (typeof hook !== 'function') {
      throw new Error(
        `File modification denied: no explicit authorization hook configured for '${actionDetails.operation}'.`
      );
    }

    let decision;
    try {
      decision = await hook(actionDetails);
    } catch (err) {
      throw new Error(
        `File modification authorization failed for '${actionDetails.path}': ${err.message}`
      );
    }

    if (decision === true) return;

    if (typeof decision === 'object' && decision !== null) {
      if (decision.approved === true || decision.decision === 'allowed') {
        return;
      }
      const reason = decision.reason || decision.message || 'Action rejected by policy.';
      throw new Error(`File modification denied for '${actionDetails.path}': ${reason}`);
    }

    throw new Error(
      `File modification denied for '${actionDetails.path}': authorization hook rejected the operation.`
    );
  }

  async function listFiles(dirPath = '.', opts = {}) {
    const { absolutePath } = resolveScopedPath(dirPath, {
      allowRoot: true
    });

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Directory not found: '${dirPath}'.`);
      }
      throw err;
    }

    if (!stats.isDirectory()) {
      throw new Error(`Target is not a directory: '${dirPath}'.`);
    }

    const limit = clampBound(opts.limit, effectiveMaxEntries, HARD_MAX_ENTRIES, 1);
    const recursive = opts.recursive !== false;
    const files = [];

    async function walk(currentDir) {
      if (files.length >= limit) return;

      let entries;
      try {
        entries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (files.length >= limit) return;

        const fullPath = join(currentDir, entry.name);
        const rel = relative(resolvedRoot, fullPath);
        const normalizedRel = rel.replace(/\\/g, '/');

        if (isSensitive(normalizedRel, entry.name)) {
          continue;
        }

        if (entry.isSymbolicLink()) {
          try {
            const real = realpathSync(fullPath);
            if (
              !isPathInside(real, canonicalRoot) &&
              !isPathInside(real, resolvedRoot)
            ) {
              continue; // External symlink: rejected
            }

            const relTarget = relative(resolvedRoot, real);
            const normalizedRelTarget = relTarget === '' ? '.' : relTarget.replace(/\\/g, '/');
            if (isSensitive(normalizedRelTarget, basename(real))) {
              continue; // Sensitive symlink target: rejected
            }

            const realStat = statSync(real);
            if (realStat.isDirectory()) {
              if (recursive) await walk(fullPath);
            } else if (realStat.isFile()) {
              files.push(normalizedRel);
            }
          } catch {
            continue;
          }
          continue;
        }

        if (entry.isDirectory()) {
          if (recursive) {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          files.push(normalizedRel);
        }
      }
    }

    await walk(absolutePath);
    return { files };
  }

  async function readFileSafely(filePath, opts = {}) {
    const { absolutePath, relativePath } = resolveScopedPath(filePath);

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`File not found: '${relativePath}'.`);
      }
      throw err;
    }

    if (!stats.isFile()) {
      throw new Error(`Target is not a regular file: '${relativePath}'.`);
    }

    const limit = clampBound(opts.maxFileSize, effectiveMaxFileSize, HARD_MAX_FILE_SIZE, 1);
    if (stats.size > limit) {
      throw new Error(
        `File size (${stats.size} bytes) exceeds maximum allowed limit of ${limit} bytes for '${relativePath}'.`
      );
    }

    const content = await readFile(absolutePath, 'utf8');

    // TOCTOU post-read invariant check: verify target still resolves inside project root
    try {
      const postReal = realpathSync(absolutePath);
      if (
        !isPathInside(postReal, canonicalRoot) &&
        !isPathInside(postReal, resolvedRoot)
      ) {
        throw new Error(
          `Symlink traversal detected post-read: target resolves outside approved project root ('${relativePath}').`
        );
      }
    } catch (err) {
      if (err.message.includes('Symlink traversal')) throw err;
    }

    return {
      path: relativePath,
      content,
      size: stats.size
    };
  }

  async function writeFileSafely(filePath, content, opts = {}) {
    if (typeof content !== 'string') {
      throw new TypeError('write_file requires string content.');
    }

    const byteLength = Buffer.byteLength(content, 'utf8');
    const limit = clampBound(opts.maxFileSize, effectiveMaxFileSize, HARD_MAX_FILE_SIZE, 1);
    if (byteLength > limit) {
      throw new Error(
        `Content size (${byteLength} bytes) exceeds maximum allowed limit of ${limit} bytes.`
      );
    }

    const { absolutePath, relativePath } = resolveScopedPath(filePath);

    let previousContent = '';
    let exists = false;
    if (existsSync(absolutePath)) {
      exists = true;
      const stats = await stat(absolutePath);
      if (!stats.isFile()) {
        throw new Error(`Target is not a regular file: '${relativePath}'.`);
      }
      previousContent = await readFile(absolutePath, 'utf8');
    }

    await checkAuthorization(
      {
        path: relativePath,
        absolutePath,
        operation: 'write',
        content,
        previousContent,
        exists
      },
      opts
    );

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');

    // TOCTOU post-write invariant check: verify target did not escape project root via race
    try {
      const postReal = realpathSync(absolutePath);
      if (
        !isPathInside(postReal, canonicalRoot) &&
        !isPathInside(postReal, resolvedRoot)
      ) {
        throw new Error(
          `Symlink traversal detected post-write: target resolves outside approved project root ('${relativePath}').`
        );
      }
    } catch (err) {
      if (err.message.includes('Symlink traversal')) throw err;
    }

    return {
      path: relativePath,
      changed: !exists || previousContent !== content,
      previousBytes: Buffer.byteLength(previousContent, 'utf8'),
      newBytes: byteLength
    };
  }

  async function patchFileSafely(filePath, patchSpec, opts = {}) {
    const { absolutePath, relativePath } = resolveScopedPath(filePath);

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`File to patch not found: '${relativePath}'.`);
      }
      throw err;
    }

    if (!stats.isFile()) {
      throw new Error(`Target is not a regular file: '${relativePath}'.`);
    }

    const limit = clampBound(opts.maxFileSize, effectiveMaxFileSize, HARD_MAX_FILE_SIZE, 1);
    if (stats.size > limit) {
      throw new Error(
        `File size (${stats.size} bytes) exceeds maximum allowed limit of ${limit} bytes for '${relativePath}'.`
      );
    }

    const previousContent = await readFile(absolutePath, 'utf8');

    let newContent;
    if (typeof patchSpec === 'function') {
      newContent = await patchSpec(previousContent);
    } else if (typeof patchSpec === 'object' && patchSpec !== null) {
      const { targetContent, replacementContent, allowMultiple = false } = patchSpec;
      if (typeof targetContent !== 'string' || typeof replacementContent !== 'string') {
        throw new TypeError(
          'Patch specification must include string targetContent and replacementContent.'
        );
      }
      if (!previousContent.includes(targetContent)) {
        throw new Error(
          `Target content to patch was not found in '${relativePath}'.`
        );
      }
      if (!allowMultiple) {
        const firstIndex = previousContent.indexOf(targetContent);
        const secondIndex = previousContent.indexOf(
          targetContent,
          firstIndex + targetContent.length
        );
        if (secondIndex !== -1) {
          throw new Error(
            `Target content occurs multiple times in '${relativePath}'. Specify unique targetContent or allowMultiple.`
          );
        }
        newContent =
          previousContent.slice(0, firstIndex) +
          replacementContent +
          previousContent.slice(firstIndex + targetContent.length);
      } else {
        newContent = previousContent.replaceAll(targetContent, replacementContent);
      }
    } else {
      throw new TypeError(
        'Invalid patch specification: must be a function or an object with targetContent and replacementContent.'
      );
    }

    if (typeof newContent !== 'string') {
      throw new TypeError('Patch resulted in non-string content.');
    }

    const newBytes = Buffer.byteLength(newContent, 'utf8');
    if (newBytes > limit) {
      throw new Error(
        `Patched content size (${newBytes} bytes) exceeds maximum allowed limit of ${limit} bytes.`
      );
    }

    await checkAuthorization(
      {
        path: relativePath,
        absolutePath,
        operation: 'patch',
        content: newContent,
        previousContent,
        patch: patchSpec
      },
      opts
    );

    await writeFile(absolutePath, newContent, 'utf8');

    // TOCTOU post-patch invariant check: verify target did not escape project root via race
    try {
      const postReal = realpathSync(absolutePath);
      if (
        !isPathInside(postReal, canonicalRoot) &&
        !isPathInside(postReal, resolvedRoot)
      ) {
        throw new Error(
          `Symlink traversal detected post-patch: target resolves outside approved project root ('${relativePath}').`
        );
      }
    } catch (err) {
      if (err.message.includes('Symlink traversal')) throw err;
    }

    return {
      path: relativePath,
      changed: previousContent !== newContent,
      previousBytes: Buffer.byteLength(previousContent, 'utf8'),
      newBytes
    };
  }

  function fileExists(filePath) {
    try {
      const { absolutePath } = resolveScopedPath(filePath);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  }

  return {
    get projectRoot() {
      return resolvedRoot;
    },
    get canonicalRoot() {
      return canonicalRoot;
    },
    get maxFileSize() {
      return effectiveMaxFileSize;
    },
    get maxEntries() {
      return effectiveMaxEntries;
    },
    get hardMaxFileSize() {
      return HARD_MAX_FILE_SIZE;
    },
    get hardMaxEntries() {
      return HARD_MAX_ENTRIES;
    },
    resolvePath: (inputPath, opts) => resolveScopedPath(inputPath, opts),
    isSensitive: (pathToCheck, fileName) => isSensitive(pathToCheck, fileName),
    listFiles,
    readFile: readFileSafely,
    writeFile: writeFileSafely,
    patchFile: patchFileSafely,
    fileExists
  };
}
