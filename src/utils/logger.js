const winston = require('winston');
const path = require('path');
const config = require('../../config/default');
const { redact } = require('./redact');

// Never let credentials reach log files, the console or the SSE stream
const redactSecrets = winston.format((info) => {
  if (typeof info.message === 'string') info.message = redact(info.message);
  for (const key of Object.keys(info)) {
    if (typeof info[key] === 'string' && key !== 'level' && key !== 'message') info[key] = redact(info[key]);
  }
  return info;
});

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    redactSecrets(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'ai-factory' },
  transports: [
    new winston.transports.Console({
      // MCP stdio servers must keep stdout clean for the protocol
      stderrLevels: process.env.LOG_TO_STDERR === 'true' ? ['error', 'warn', 'info', 'debug', 'verbose', 'silly'] : [],
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, agent, taskId, moduleId, ...rest }) => {
          const ctx = [agent, taskId, moduleId].filter(Boolean).join(' | ');
          const prefix = ctx ? `[${ctx}]` : '';
          const extra = Object.keys(rest).length > 1 ? ` ${JSON.stringify(rest)}` : '';
          return `${timestamp} ${level}: ${prefix} ${message}${extra}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(config.logging.dir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(config.logging.dir, 'combined.log'),
    }),
  ],
});

/**
 * Create a child logger scoped to a specific agent.
 * @param {string} agentName
 * @returns {winston.Logger}
 */
logger.forAgent = (agentName) => logger.child({ agent: agentName });

module.exports = logger;
