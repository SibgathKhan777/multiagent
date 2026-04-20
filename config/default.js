require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,

  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/multiagent',
    options: {},
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  queue: {
    name: 'worker-tasks',
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY, 10) || 3,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: false,
      removeOnFail: false,
    },
  },

  pipeline: {
    qualityThreshold: parseInt(process.env.QUALITY_THRESHOLD, 10) || 70,
    maxIterations: parseInt(process.env.MAX_ITERATIONS, 10) || 3,
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: 'logs',
  },
};
