const { Queue, Worker: BullWorker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../../config/default');
const worker = require('../agents/worker');
const logger = require('../utils/logger').forAgent('Queue');

let connection = null;
let taskQueue = null;
let queueWorker = null;

// Event listeners registered by the controller
const completionCallbacks = new Map();

/**
 * Initialize the BullMQ queue and worker processor.
 */
function initQueue() {
  connection = new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connection.on('error', (err) => {
    logger.error('Redis connection error', { error: err.message });
  });

  // Create the queue
  taskQueue = new Queue(config.queue.name, {
    connection,
    defaultJobOptions: config.queue.defaultJobOptions,
  });

  // Create the worker processor
  queueWorker = new BullWorker(
    config.queue.name,
    async (job) => {
      const { prompt, model, moduleContext } = job.data;
      logger.info(`Processing job: ${job.id} — module: ${moduleContext.name}`, { jobId: job.id });

      try {
        const result = await worker.executeWork({ prompt, model, moduleContext });
        logger.info(`Job completed: ${job.id}`, { jobId: job.id, codeLength: result.code.length });
        return result;
      } catch (err) {
        logger.error(`Job failed: ${job.id}`, { jobId: job.id, error: err.message });
        throw err;
      }
    },
    {
      connection,
      concurrency: config.queue.concurrency,
    }
  );

  // Handle completion events
  queueWorker.on('completed', (job, result) => {
    logger.info(`Job ${job.id} completed successfully`);
    const callback = completionCallbacks.get(job.data.moduleContext?.moduleId);
    if (callback) {
      callback(null, result, job.data);
      completionCallbacks.delete(job.data.moduleContext?.moduleId);
    }
  });

  queueWorker.on('failed', (job, err) => {
    logger.error(`Job ${job.id} failed: ${err.message}`);
    const callback = completionCallbacks.get(job.data.moduleContext?.moduleId);
    if (callback) {
      callback(err, null, job.data);
      completionCallbacks.delete(job.data.moduleContext?.moduleId);
    }
  });

  logger.info('Queue system initialized', { queueName: config.queue.name, concurrency: config.queue.concurrency });
  return { taskQueue, queueWorker };
}

/**
 * Add a job to the worker queue.
 * @param {Object} jobData - { prompt, model, moduleContext }
 * @param {Function} onComplete - callback(err, result, jobData)
 * @returns {Promise<Object>} BullMQ job
 */
async function enqueueJob(jobData, onComplete) {
  if (!taskQueue) throw new Error('Queue not initialized. Call initQueue() first.');

  const job = await taskQueue.add('worker-task', jobData, {
    jobId: `${jobData.moduleContext.moduleId}-iter-${jobData.moduleContext.iteration || 0}`,
  });

  if (onComplete) {
    completionCallbacks.set(jobData.moduleContext.moduleId, onComplete);
  }

  logger.info(`Job enqueued: ${job.id}`, {
    moduleId: jobData.moduleContext.moduleId,
    moduleName: jobData.moduleContext.name,
    model: jobData.model,
  });

  return job;
}

/**
 * Gracefully shut down the queue system.
 */
async function closeQueue() {
  if (queueWorker) await queueWorker.close();
  if (taskQueue)   await taskQueue.close();
  if (connection)  await connection.quit();
  logger.info('Queue system shut down');
}

module.exports = { initQueue, enqueueJob, closeQueue };
