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

  // Sandboxed execution of generated projects (Docker). Generated code is untrusted.
  execution: {
    image: process.env.EXEC_IMAGE || 'node:20-alpine',
    memory: process.env.EXEC_MEMORY || '512m',
    cpus: parseFloat(process.env.EXEC_CPUS) || 1,
    pidsLimit: parseInt(process.env.EXEC_PIDS_LIMIT, 10) || 256,
    installTimeoutMs: parseInt(process.env.EXEC_INSTALL_TIMEOUT_MS, 10) || 120000,
    testTimeoutMs: parseInt(process.env.EXEC_TEST_TIMEOUT_MS, 10) || 90000,
    maxOutputBytes: 200 * 1024,
    maxFiles: 200,
    maxFileBytes: 512 * 1024,
    // How many times failing tests are fed back to the coder before giving up
    maxRepairRounds: parseInt(process.env.EXEC_MAX_REPAIR_ROUNDS, 10) || 2,
    keepWorkdir: process.env.EXEC_KEEP_WORKDIR === 'true',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: 'logs',
  },
};
