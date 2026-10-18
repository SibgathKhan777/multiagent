const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-secrets.js');
const FAKE_GROQ = 'gsk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretscan-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  spawnSync('git', ['add', '-A', '-f'], { cwd: dir });
  return dir;
}
const scan = (dir) => spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });

describe('scripts/check-secrets.js', () => {
  test('passes on a clean repo', () => {
    const r = scan(repo({ 'a.js': 'const key = process.env.GROQ_API_KEY;' }));
    expect(r.status).toBe(0);
  });
  test.each([
    ['Groq key', { 'src/x.js': `const k = "${FAKE_GROQ}";` }],
    ['private key block', { 'k.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc' }],
    ['Mongo URI with password', { 'c.js': "uri = 'mongodb://admin:hunter22@db.example.com/app'" }],
    ['tracked .env', { '.env': 'X=1' }],
  ])('fails on %s', (_n, files) => {
    const r = scan(repo(files));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/possible secrets/);
  });
  test('does not echo the secret itself', () => {
    const r = scan(repo({ 'src/x.js': `const k = "${FAKE_GROQ}";` }));
    expect(r.stderr).not.toContain(FAKE_GROQ);
  });
  test('fixtures under tests/ are ignored', () => {
    expect(scan(repo({ 'tests/fake.js': `"${FAKE_GROQ}"` })).status).toBe(0);
  });
});
