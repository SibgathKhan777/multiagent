const winston = require('winston');
const path = require('path');
const config = require('../../config/default');

const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'ai-factory' },
  transports: [
    new winston.transports.Console({
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
