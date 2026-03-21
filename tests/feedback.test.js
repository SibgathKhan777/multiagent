const { generateFeedback } = require('../src/agents/feedback');

describe('Feedback Agent', () => {
  const testIssues = [
    { type: 'error', message: 'Missing module.exports — module has no public interface', severity: 8 },
    { type: 'warning', message: 'No error handling detected', severity: 6 },
  ];

  test('generates a refined prompt from issues', async () => {
    const result = await generateFeedback({
      issues: testIssues,
      originalPrompt: 'Build a user authentication module',
      code: 'function login() {}',
      iteration: 0,
    });

    expect(typeof result.refinedPrompt).toBe('string');
    expect(result.refinedPrompt.length).toBeGreaterThan(100);
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  test('includes original prompt in refined version', async () => {
    const originalPrompt = 'Build a user authentication module';
    const result = await generateFeedback({
      issues: testIssues,
      originalPrompt,
      code: 'function login() {}',
      iteration: 0,
    });

    expect(result.refinedPrompt).toContain(originalPrompt);
  });

  test('includes fix instructions for each issue', async () => {
    const result = await generateFeedback({
      issues: testIssues,
      originalPrompt: 'Build auth',
      code: '',
      iteration: 0,
    });

    expect(result.refinedPrompt).toContain('module.exports');
    expect(result.refinedPrompt.toLowerCase()).toContain('error handling');
  });

  test('escalates on later iterations', async () => {
    const result = await generateFeedback({
      issues: testIssues,
      originalPrompt: 'Build auth',
      code: '',
      iteration: 2,
    });

    expect(result.refinedPrompt).toContain('FINAL ATTEMPT');
  });

  test('includes MANDATORY FIXES section', async () => {
    const result = await generateFeedback({
      issues: testIssues,
      originalPrompt: 'Build auth',
      code: '',
      iteration: 0,
    });

    expect(result.refinedPrompt).toContain('MANDATORY FIXES');
  });
});
