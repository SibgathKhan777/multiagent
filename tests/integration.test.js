const { integrate } = require('../src/agents/integration');

describe('Integration Agent', () => {
  const testModules = [
    {
      name: 'Configuration Module',
      description: 'App config',
      type: 'config',
      dependencies: [],
      output: "'use strict';\nconst config = { port: 3000 };\nmodule.exports = config;",
    },
    {
      name: 'Database Module',
      description: 'MongoDB models',
      type: 'database',
      dependencies: [],
      output: "'use strict';\nconst mongoose = require('mongoose');\nasync function connectDB(uri) { await mongoose.connect(uri); }\nmodule.exports = { connectDB };",
    },
    {
      name: 'API Routes Module',
      description: 'Express routes',
      type: 'api',
      dependencies: ['Database Module', 'Authentication Module'],
      output: "'use strict';\nconst express = require('express');\nconst router = express.Router();\nrouter.get('/health', (req, res) => res.json({ ok: true }));\nmodule.exports = router;",
    },
  ];

  test('generates integrated project output', async () => {
    const result = await integrate({ modules: testModules });

    expect(result).toHaveProperty('projectStructure');
    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('packageJson');
    expect(result).toHaveProperty('readme');
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });

  test('generates package.json with dependencies', async () => {
    const result = await integrate({ modules: testModules });

    expect(result.packageJson).toHaveProperty('dependencies');
    expect(result.packageJson.dependencies).toHaveProperty('express');
    expect(result.packageJson.dependencies).toHaveProperty('mongoose');
  });

  test('generates entry point file', async () => {
    const result = await integrate({ modules: testModules });

    const entryPoint = result.files.find((f) => f.path === 'src/index.js');
    expect(entryPoint).toBeDefined();
    expect(entryPoint.content).toContain('express');
  });

  test('generates .env.example', async () => {
    const result = await integrate({ modules: testModules });

    const envFile = result.files.find((f) => f.path === '.env.example');
    expect(envFile).toBeDefined();
    expect(envFile.content).toContain('PORT');
  });

  test('maintains dependency order', async () => {
    const result = await integrate({ modules: testModules });

    const moduleFiles = result.files.filter((f) => f.module && f.module !== 'Entry Point' && f.module !== 'Environment');
    const configIdx = moduleFiles.findIndex((f) => f.module === 'Configuration Module');
    const apiIdx = moduleFiles.findIndex((f) => f.module === 'API Routes Module');

    // Config should come before API (lower priority / no deps)
    expect(configIdx).toBeLessThan(apiIdx);
  });

  test('generates readme with setup instructions', async () => {
    const result = await integrate({ modules: testModules });

    expect(result.readme).toContain('npm install');
    expect(result.readme).toContain('npm start');
  });

  test('generated tests only assert named exports for object-literal exports', () => {
    const { generateTestFile } = require('../src/agents/integration');
    const single = generateTestFile({ name: 'Cfg', output: 'const config = {};\nmodule.exports = config;' }, 'config/cfg.js');
    expect(single).not.toContain('moduleExports.config');
    expect(single).toContain('toBeDefined');
    const obj = generateTestFile({ name: 'Svc', output: 'function a(){}\nmodule.exports = { a };' }, 'src/svc.js');
    expect(obj).toContain('expect(moduleExports.a).toBeDefined()');
  });
});
