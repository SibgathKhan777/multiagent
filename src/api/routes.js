const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const controller = require('../core/controller');
const modelsConfig = require('../../config/models');
const progressEmitter = require('../realtime/progressEmitter');
const logger = require('../utils/logger').forAgent('API');

// SSE clients
const sseClients = new Map(); // taskId → Set<res>

/**
 * Broadcast an event to all SSE clients for a given taskId.
 */
function broadcastSSE(taskId, data) {
  const clients = sseClients.get(taskId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

// Make broadcast available to other modules
router.broadcastSSE = broadcastSSE;

/**
 * POST /api/pipeline
 * Start a new AI Factory pipeline.
 */
router.post('/pipeline', async (req, res) => {
  try {
    const { idea } = req.body;
    if (!idea || typeof idea !== 'string' || idea.trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Please provide an "idea" string with at least 5 characters.' });
    }

    logger.info(`New pipeline requested: "${idea.substring(0, 80)}"`);
    const result = await controller.startPipeline(idea.trim());

    res.status(201).json({
      success: true,
      data: {
        taskId: result.taskId,
        status: result.status,
        message: 'Pipeline started. Poll GET /api/pipeline/:taskId for progress.',
      },
    });
  } catch (err) {
    logger.error('Failed to start pipeline', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/pipeline/:taskId/stream
 * Server-Sent Events for live pipeline updates.
 */
router.get('/pipeline/:taskId/stream', (req, res) => {
  const { taskId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Register client
  if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
  sseClients.get(taskId).add(res);

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', taskId })}\n\n`);

  // Cleanup on disconnect
  req.on('close', () => {
    const clients = sseClients.get(taskId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(taskId);
    }
  });
});

/**
 * GET /api/pipeline/:taskId
 */
router.get('/pipeline/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const status = await controller.getPipelineStatus(taskId);
    if (!status) return res.status(404).json({ success: false, error: 'Pipeline not found' });
    res.json({ success: true, data: status });
  } catch (err) {
    logger.error('Failed to get pipeline status', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/pipeline/:taskId/output
 */
router.get('/pipeline/:taskId/output', async (req, res) => {
  try {
    const { taskId } = req.params;
    const output = await controller.getPipelineOutput(taskId);
    if (!output) return res.status(404).json({ success: false, error: 'Output not found. Pipeline may not be completed yet.' });
    res.json({ success: true, data: output });
  } catch (err) {
    logger.error('Failed to get pipeline output', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/pipeline/:taskId/download
 * Download generated project as ZIP.
 */
router.get('/pipeline/:taskId/download', async (req, res) => {
  try {
    const { taskId } = req.params;
    const output = await controller.getPipelineOutput(taskId);
    if (!output || !output.files) {
      return res.status(404).json({ success: false, error: 'Output not found. Pipeline may not be completed yet.' });
    }

    const projectName = output.packageJson?.name || 'generated-project';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${projectName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const file of output.files) {
      archive.append(file.content, { name: `${projectName}/${file.path}` });
    }

    await archive.finalize();
    logger.info(`ZIP download completed: ${projectName}`, { taskId, fileCount: output.files.length });
  } catch (err) {
    logger.error('Failed to generate ZIP download', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/pipelines
 */
router.get('/pipelines', async (req, res) => {
  try {
    const pipelines = await controller.listPipelines();
    res.json({ success: true, data: pipelines });
  } catch (err) {
    logger.error('Failed to list pipelines', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/progress
 * Receives stage updates from the Python AI service and fans them out via Socket.IO.
 * Body: { task_id, stage, data }
 *
 * Stage → Socket.IO event mapping:
 *   started          → pipeline:started
 *   architect_start, architect_done, coder_start, coder_done,
 *   reviewer_done, tester_done  → pipeline:stage
 *   retry            → pipeline:retry
 *   integrator_done  → pipeline:completed
 */
const STAGE_EVENTS = {
  started:         'pipeline:started',
  architect_start: 'pipeline:stage',
  architect_done:  'pipeline:stage',
  coder_start:     'pipeline:stage',
  coder_done:      'pipeline:stage',
  reviewer_done:   'pipeline:stage',
  retry:           'pipeline:retry',
  tester_start:    'pipeline:stage',
  tester_done:     'pipeline:stage',
  integrator_done: 'pipeline:completed',
};

router.post('/progress', (req, res) => {
  const { task_id, stage, data = {} } = req.body;
  if (!task_id || !stage) {
    return res.status(400).json({ error: 'task_id and stage are required' });
  }
  const event = STAGE_EVENTS[stage] || 'pipeline:stage';
  progressEmitter.emit(task_id, event, { stage, ...data });
  res.json({ ok: true });
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
  const providerName = modelsConfig.displayNames[modelsConfig.provider] || modelsConfig.provider;
  res.json({
    success: true,
    data: {
      status: 'healthy',
      service: 'AI Software Factory',
      provider: providerName,
      timestamp: new Date().toISOString(),
    },
  });
});

module.exports = router;
