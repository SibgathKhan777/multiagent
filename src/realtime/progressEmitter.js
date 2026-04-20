'use strict';

const logger = require('../utils/logger').forAgent('ProgressEmitter');

let _io = null;

/**
 * Bind the Socket.IO server instance. Called once at startup.
 */
function init(io) {
  _io = io;
  logger.info('ProgressEmitter initialised with Socket.IO');
}

/**
 * Emit a named event to all browser clients joined to the given taskId room.
 * @param {string} taskId
 * @param {string} event   - 'pipeline:started' | 'pipeline:stage' | 'pipeline:retry' | 'pipeline:completed'
 * @param {Object} data
 */
function emit(taskId, event, data = {}) {
  if (!_io) {
    logger.warn('emit() called before init() — Socket.IO not ready');
    return;
  }
  const payload = { taskId, ...data, ts: Date.now() };
  _io.to(taskId).emit(event, payload);
  logger.info(`[socket] ${event} → room ${taskId}`, { stage: data.stage });
}

module.exports = { init, emit };
