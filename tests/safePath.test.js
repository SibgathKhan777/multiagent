const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSafe, writeFilesSafely, UnsafePathError } = require('../src/utils/safePath');

describe('safePath', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'safepath-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test.each([
    '../evil.js', 'a/../../evil.js', '/etc/passwd', 'C:/x.js', 'a\\..\\b.js',
    '', '..', '.', 'node_modules/pkg/index.js', '.git/hooks/pre-commit', 'a\0b.js',
  ])('rejects %j', (p) => {
    expect(() => resolveSafe(root, p)).toThrow(UnsafePathError);
  });

  test('accepts nested relative paths', () => {
    expect(resolveSafe(root, 'src/auth/auth.js')).toBe(path.join(root, 'src/auth/auth.js'));
    expect(resolveSafe(root, './src/../src/a.js')).toBe(path.join(root, 'src/a.js'));
  });

  test('writes files', () => {
    const n = writeFilesSafely(root, [{ path: 'src/a.js', content: 'x' }, { path: 'package.json', content: '{}' }]);
    expect(n).toBe(2);
    expect(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8')).toBe('x');
  });

  test('writes nothing if any path is unsafe', () => {
    expect(() => writeFilesSafely(root, [
      { path: 'ok.js', content: 'x' },
      { path: '../escape.js', content: 'y' },
    ])).toThrow(UnsafePathError);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, '..', 'escape.js'))).toBe(false);
  });

  test('enforces file count, size and content type limits', () => {
    expect(() => writeFilesSafely(root, [{ path: 'a', content: '' }, { path: 'b', content: '' }], { maxFiles: 1 })).toThrow(/Too many/);
    expect(() => writeFilesSafely(root, [{ path: 'a', content: 'xxxx' }], { maxFileBytes: 2 })).toThrow(/too large/);
    expect(() => writeFilesSafely(root, [{ path: 'a', content: 42 }])).toThrow(UnsafePathError);
  });
});
