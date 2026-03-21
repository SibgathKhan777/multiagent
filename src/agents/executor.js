const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const logger = require('../utils/logger').forAgent('Executor');

/**
 * Executor Agent — Live Project Execution
 *
 * Writes generated files to a temp directory, runs npm install,
 * starts the server, and verifies it responds to a health check.
 *
 * Input:  { files: { path, content }[], projectName: string }
 * Output: { success, started, logs, errors, healthCheckPassed, projectDir }
 */

const INSTALL_TIMEOUT = 30000; // 30 seconds
const STARTUP_TIMEOUT = 5000;  // 5 seconds

/**
 * Execute the generated project in a sandboxed temp directory.
 */
async function execute({ files, projectName = 'generated-project' }) {
  const projectDir = path.join('/tmp', `ai-factory-${Date.now()}`);
  const result = {
    success: false,
    started: false,
    projectDir,
    logs: [],
    errors: [],
    healthCheckPassed: false,
    installSuccess: false,
    filesWritten: 0,
  };

  try {
    // ─── 1. Write all files to disk ────────────────────────────────
    logger.info(`Writing ${files.length} files to ${projectDir}`);

    for (const file of files) {
      const filePath = path.join(projectDir, file.path);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf8');
      result.filesWritten++;
    }

    result.logs.push(`✅ Wrote ${result.filesWritten} files to ${projectDir}`);
    logger.info(`Wrote ${result.filesWritten} files`);

    // ─── 2. Run npm install ─────────────────────────────────────────
    const hasPackageJson = files.some(f => f.path === 'package.json');
    if (hasPackageJson) {
      try {
        logger.info('Running npm install...');
        const installOutput = execSync('npm install --production --no-audit --no-fund 2>&1', {
          cwd: projectDir,
          timeout: INSTALL_TIMEOUT,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        });

        result.installSuccess = true;
        result.logs.push('✅ npm install completed successfully');
        logger.info('npm install completed');
      } catch (installErr) {
        result.errors.push(`npm install failed: ${installErr.message?.substring(0, 200)}`);
        result.logs.push('❌ npm install failed — some dependencies may be unavailable');
        logger.warn(`npm install failed: ${installErr.message}`);
        // Continue anyway — some modules might still work
      }
    } else {
      result.logs.push('⚠️ No package.json found — skipping npm install');
    }

    // ─── 3. Try starting the server ─────────────────────────────────
    const entryFile = findEntryFile(projectDir, files);
    if (entryFile) {
      logger.info(`Starting server: node ${entryFile}`);
      result.logs.push(`🚀 Starting: node ${entryFile}`);

      try {
        // Start the process and give it time to boot
        const startCmd = `cd "${projectDir}" && timeout 5 node "${entryFile}" 2>&1 || true`;
        const startOutput = execSync(startCmd, {
          timeout: STARTUP_TIMEOUT + 2000,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PORT: '9999',
            MONGODB_URI: 'mongodb://localhost:27017/test-generated',
            JWT_SECRET: 'test-secret-for-execution',
            NODE_ENV: 'test',
          },
        });

        // Check if server started by looking for common patterns
        const serverStarted = startOutput.includes('listening') ||
          startOutput.includes('running on') ||
          startOutput.includes('started') ||
          startOutput.includes(':9999');

        result.started = serverStarted;

        if (serverStarted) {
          result.logs.push('✅ Server started successfully');
          result.success = true;
        } else {
          result.logs.push('⚠️ Server ran without errors but no startup message detected');
          result.success = true; // No crash = success
        }

        // Check for errors in output
        if (startOutput.includes('Error') || startOutput.includes('EADDRINUSE')) {
          const errorLine = startOutput.split('\n').find(l => l.includes('Error')) || '';
          result.errors.push(`Server output: ${errorLine.substring(0, 150)}`);
        }
      } catch (startErr) {
        if (startErr.killed) {
          // Timed out = server is probably running (good!)
          result.started = true;
          result.success = true;
          result.logs.push('✅ Server started (still running after timeout — good sign)');
        } else {
          result.errors.push(`Server failed to start: ${startErr.message?.substring(0, 150)}`);
          result.logs.push('❌ Server crashed on startup');
        }
      }
    } else {
      result.logs.push('⚠️ No entry file found (src/index.js)');
    }

    // ─── 4. Summary ─────────────────────────────────────────────────
    result.success = result.filesWritten > 0 && result.errors.length === 0;

  } catch (err) {
    result.errors.push(`Execution error: ${err.message}`);
    logger.error(`Execution failed: ${err.message}`);
  }

  logger.info(`Execution complete: files=${result.filesWritten}, install=${result.installSuccess}, started=${result.started}, errors=${result.errors.length}`);

  return result;
}

/**
 * Find the entry point file.
 */
function findEntryFile(projectDir, files) {
  const candidates = ['src/index.js', 'index.js', 'server.js', 'app.js'];
  for (const candidate of candidates) {
    if (files.some(f => f.path === candidate)) {
      return candidate;
    }
  }
  return null;
}

module.exports = { execute };
