require('dotenv').config();

const http = require('http');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../config/default');
const { initQueue, closeQueue } = require('./queue/queue');
const memory = require('./memory/memory');
const routes = require('./api/routes');
const progressEmitter = require('./realtime/progressEmitter');
const logger = require('./utils/logger').forAgent('App');

const app = express();

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} — ${Date.now() - start}ms`);
  });
  next();
});

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve dashboard (no-cache for development)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  },
}));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api', routes);

// Root redirect to dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─── SSE Log Broadcasting ────────────────────────────────────────────────────
// Hook into Winston to broadcast logs to SSE clients
const originalLog = logger.log.bind(logger);
const winston = require('winston');
const baseLogger = require('./utils/logger');

// Add a custom transport that broadcasts to SSE
class SSETransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => {
      const taskId = info.taskId;
      if (taskId && routes.broadcastSSE) {
        routes.broadcastSSE(taskId, {
          type: 'log',
          level: info.level,
          message: info.message,
          agent: info.agent || '',
          taskId,
          timestamp: info.timestamp || new Date().toISOString(),
        });
      }
    });
    callback();
  }
}

baseLogger.add(new SSETransport());

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  try {
    logger.info('Connecting to MongoDB...', { uri: config.mongodb.uri });
    await mongoose.connect(config.mongodb.uri, config.mongodb.options);
    logger.info('MongoDB connected');

    logger.info('Initializing queue system...');
    initQueue();
    logger.info('Queue system ready');

    await memory.loadFromDB();

    const modelsConfig = require('../config/models');
    const providerName = modelsConfig.displayNames[modelsConfig.provider] || modelsConfig.provider;
    logger.info(`AI Provider: ${providerName}`);

    // ── Socket.IO ────────────────────────────────────────────────
    const httpServer = http.createServer(app);
    const io = new SocketIOServer(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
    });

    progressEmitter.init(io);

    io.on('connection', (socket) => {
      logger.info(`Socket connected: ${socket.id}`);

      // Client joins a room identified by the taskId it wants to watch.
      socket.on('watch', (taskId) => {
        socket.join(taskId);
        logger.info(`Socket ${socket.id} watching task ${taskId}`);
      });

      socket.on('disconnect', () => {
        logger.info(`Socket disconnected: ${socket.id}`);
      });
    });

    const server = httpServer.listen(config.port, () => {
      logger.info(`🚀 AI Software Factory running on http://localhost:${config.port}`);
      logger.info(`📊 Dashboard: http://localhost:${config.port}`);
      logger.info('Ready to process ideas!');
    });

    const shutdown = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);
      io.close();
      server.close();
      await closeQueue();
      await mongoose.connection.close();
      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (err) {
    logger.error('Failed to start', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();

module.exports = app;
