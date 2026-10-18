const fs = require('fs');
const path = require('path');

/**
 * Safe file writing for untrusted (LLM-generated) file lists.
 * Every path is validated BEFORE anything is written, so a bad file list
 * never produces a partially written project.
 */

class UnsafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const BLOCKED_TOP_LEVEL = new Set(['node_modules', '.git']);

/**
 * Resolve relPath inside root, or throw UnsafePathError if it would escape.
 */
function resolveSafe(root, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new UnsafePathError('File path must be a non-empty string');
  }
  if (relPath.includes('\0')) throw new UnsafePathError(`Null byte in path: ${JSON.stringify(relPath)}`);
  if (relPath.includes('\\')) throw new UnsafePathError(`Backslash in path: ${relPath}`);
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new UnsafePathError(`Absolute path not allowed: ${relPath}`);
  }

  const normalized = path.posix.normalize(relPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new UnsafePathError(`Path escapes project directory: ${relPath}`);
  }
  if (BLOCKED_TOP_LEVEL.has(normalized.split('/')[0])) {
    throw new UnsafePathError(`Writing into ${normalized.split('/')[0]}/ is not allowed: ${relPath}`);
  }

  const rootResolved = path.resolve(root);
  const full = path.resolve(rootResolved, normalized);
  if (!full.startsWith(rootResolved + path.sep)) {
    throw new UnsafePathError(`Path escapes project directory: ${relPath}`);
  }
  return full;
}

/**
 * Validate the whole file list, then write it under root.
 * @returns {number} number of files written
 */
function writeFilesSafely(root, files, { maxFiles = 200, maxFileBytes = 512 * 1024 } = {}) {
  if (!Array.isArray(files)) throw new UnsafePathError('files must be an array');
  if (files.length > maxFiles) throw new UnsafePathError(`Too many files: ${files.length} > ${maxFiles}`);

  const planned = files.map((file) => {
    if (typeof file?.content !== 'string') {
      throw new UnsafePathError(`File ${file?.path} has non-string content`);
    }
    if (Buffer.byteLength(file.content, 'utf8') > maxFileBytes) {
      throw new UnsafePathError(`File too large: ${file.path}`);
    }
    return { full: resolveSafe(root, file.path), content: file.content };
  });

  for (const { full, content } of planned) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, { encoding: 'utf8', mode: 0o644 });
  }
  return planned.length;
}

module.exports = { resolveSafe, writeFilesSafely, UnsafePathError };
