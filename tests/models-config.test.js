describe('model defaults', () => {
  test('do not point at ids known to be retired upstream', () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^(GROQ|GEMINI)_MODEL_/.test(k)) delete process.env[k];
    jest.resetModules();
    const m = require('../config/models');
    const ids = [...Object.values(m.groq.models), ...Object.values(m.gemini.models)];
    expect(ids.join(' ')).not.toMatch(/llama-3\.[13]|gemini-2\.0-flash/);
    expect(m.groq.models.fast).toBe('openai/gpt-oss-120b');
    process.env = saved;
  });

  test('env overrides still win', () => {
    process.env.GROQ_MODEL_FAST = 'custom/model';
    jest.resetModules();
    expect(require('../config/models').groq.models.fast).toBe('custom/model');
    delete process.env.GROQ_MODEL_FAST;
    jest.resetModules();
  });
});
