const { decompose } = require('../src/agents/decomposer');

describe('Decomposer Agent', () => {
  test('decomposes a food delivery idea into modules', async () => {
    const modules = await decompose({ idea: 'Build a scalable food delivery backend system' });

    expect(Array.isArray(modules)).toBe(true);
    expect(modules.length).toBeGreaterThanOrEqual(4);
    expect(modules.length).toBeLessThanOrEqual(15);

    // Should have core modules
    const names = modules.map((m) => m.name);
    expect(names).toContain('Configuration Module');
    expect(names).toContain('Database Module');
    expect(names).toContain('API Routes Module');

    // Each module should have required fields
    for (const mod of modules) {
      expect(mod).toHaveProperty('moduleId');
      expect(mod).toHaveProperty('name');
      expect(mod).toHaveProperty('description');
      expect(mod).toHaveProperty('type');
      expect(mod).toHaveProperty('dependencies');
      expect(mod).toHaveProperty('priority');
      expect(typeof mod.name).toBe('string');
      expect(Array.isArray(mod.dependencies)).toBe(true);
    }
  });

  test('detects domain-specific modules for food delivery', async () => {
    const modules = await decompose({ idea: 'Build a food delivery app with payment and tracking' });
    const names = modules.map((m) => m.name);

    expect(names).toContain('Payment Module');
    expect(names).toContain('Real-time Module');
  });

  test('handles e-commerce domain', async () => {
    const modules = await decompose({ idea: 'Build an e-commerce marketplace' });
    const names = modules.map((m) => m.name);

    expect(names).toContain('Payment Module');
    expect(names).toContain('Search Module');
  });

  test('always includes Core Business Logic', async () => {
    const modules = await decompose({ idea: 'Build a simple todo list' });
    const names = modules.map((m) => m.name);

    expect(names).toContain('Core Business Logic');
  });

  test('sorts by priority', async () => {
    const modules = await decompose({ idea: 'Build a blog platform' });
    for (let i = 1; i < modules.length; i++) {
      expect(modules[i].priority).toBeGreaterThanOrEqual(modules[i - 1].priority);
    }
  });
});
