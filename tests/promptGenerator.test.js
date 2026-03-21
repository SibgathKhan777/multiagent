const { generatePrompt } = require('../src/agents/promptGenerator');

describe('Prompt Generator Agent', () => {
  const testModule = {
    name: 'Authentication Module',
    description: 'User auth with JWT and bcrypt',
    type: 'authentication',
    dependencies: ['Database Module'],
  };

  test('generates a prompt with required sections', async () => {
    const { prompt, model } = await generatePrompt({ module: testModule });

    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
    expect(typeof model).toBe('string');

    // Should contain key sections
    expect(prompt).toContain('## Role');
    expect(prompt).toContain('## Task');
    expect(prompt).toContain('## Description');
    expect(prompt).toContain('## Output Format');
    expect(prompt).toContain(testModule.name);
  });

  test('includes type-specific instructions for auth', async () => {
    const { prompt } = await generatePrompt({ module: testModule });

    expect(prompt).toContain('bcrypt');
    expect(prompt).toContain('JWT');
  });

  test('includes context when provided', async () => {
    const { prompt } = await generatePrompt({ module: testModule, context: 'Part of food delivery system' });
    expect(prompt).toContain('food delivery');
  });

  test('selects appropriate model tier', async () => {
    const { model: authModel } = await generatePrompt({ module: { ...testModule, type: 'authentication' } });
    const { model: utilModel } = await generatePrompt({ module: { ...testModule, type: 'utilities' } });

    expect(typeof authModel).toBe('string');
    expect(typeof utilModel).toBe('string');
  });

  test('includes optimization instructions', async () => {
    const { prompt } = await generatePrompt({ module: testModule });

    expect(prompt).toContain('step-by-step');
    expect(prompt).toContain('error handling');
    expect(prompt.toLowerCase()).toContain('module.exports');
  });
});
