const { createApiAuth } = require('../src/api/auth');

function run(mw, { path = '/pipeline', headers = {} } = {}) {
  const res = { statusCode: null, body: null, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  mw({ path, headers }, res, () => { nexted = true; });
  return { nexted, res };
}

describe('API key auth', () => {
  test('disabled when no key is configured (backward compatible)', () => {
    expect(run(createApiAuth({ apiKey: undefined })).nexted).toBe(true);
    expect(run(createApiAuth({ apiKey: '' })).nexted).toBe(true);
  });

  const mw = createApiAuth({ apiKey: 'correct-horse-battery' });

  test.each([
    ['Bearer header', { authorization: 'Bearer correct-horse-battery' }],
    ['X-API-Key header', { 'x-api-key': 'correct-horse-battery' }],
  ])('accepts a valid key via %s', (_n, headers) => {
    expect(run(mw, { headers }).nexted).toBe(true);
  });

  test.each([
    ['no credentials', {}],
    ['wrong key', { authorization: 'Bearer nope' }],
    ['wrong X-API-Key', { 'x-api-key': 'nope' }],
    ['empty bearer', { authorization: 'Bearer ' }],
    ['prefix of the key', { 'x-api-key': 'correct-horse' }],
    ['key plus suffix', { 'x-api-key': 'correct-horse-battery-extra' }],
    ['non-bearer scheme', { authorization: 'Basic correct-horse-battery' }],
  ])('rejects %s with 401', (_n, headers) => {
    const { nexted, res } = run(mw, { headers });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toBe('Bearer');
    expect(JSON.stringify(res.body)).not.toContain('correct-horse-battery');
  });

  test('health check stays public; everything else (including callbacks) is protected', () => {
    expect(run(mw, { path: '/health' }).nexted).toBe(true);
    expect(run(mw, { path: '/progress' }).res.statusCode).toBe(401);
    expect(run(mw, { path: '/pipeline/abc/output' }).res.statusCode).toBe(401);
  });

  test('the key is never accepted from the URL', () => {
    const { nexted } = run(mw, { headers: {} , path: '/pipeline?api_key=correct-horse-battery' });
    expect(nexted).toBe(false);
  });
});

describe('API key auth over real HTTP (mounted at /api like src/index.js)', () => {
  const http = require('http');
  const express = require('express');
  let server; let port;

  beforeAll((done) => {
    const app = express();
    const r = express.Router();
    r.get('/health', (_q, res) => res.json({ ok: true }));
    r.get('/pipelines', (_q, res) => res.json({ secret: 'data' }));
    app.use('/api', createApiAuth({ apiKey: 'k-123456789' }), r);
    server = app.listen(0, () => { port = server.address().port; done(); });
  });
  afterAll((done) => { server.close(() => done()); });

  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get({ port, path, headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

  test('health is public', async () => { expect((await get('/api/health')).status).toBe(200); });
  test('protected route: 401 without key, 200 with either header', async () => {
    expect((await get('/api/pipelines')).status).toBe(401);
    expect((await get('/api/pipelines', { 'x-api-key': 'k-123456789' })).status).toBe(200);
    expect((await get('/api/pipelines', { authorization: 'Bearer k-123456789' })).status).toBe(200);
  });
  test('the key in the query string does not authenticate', async () => {
    expect((await get('/api/pipelines?api_key=k-123456789')).status).toBe(401);
  });
});
