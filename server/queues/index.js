import Queue from 'bull';
import dotenv from 'dotenv';
import { logSystemEvent } from '../db.js';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error('[QUEUES] Error: REDIS_URL is missing. Background queues might fail to connect.');
}

const queueOptions = {
  redis: {
    tls: {
      rejectUnauthorized: false
    }
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: {
      age: 24 * 3600
    }
  }
};

export const replacementEngineQueue = new Queue('replacementEngine', REDIS_URL, queueOptions);
export const dailyPayoutsQueue = new Queue('dailyPayouts', REDIS_URL, queueOptions);
export const kycVerificationQueue = new Queue('kycVerification', REDIS_URL, queueOptions);
export const idCardDispatchQueue = new Queue('idCardDispatch', REDIS_URL, queueOptions);
export const notificationsQueue = new Queue('notifications', REDIS_URL, queueOptions);
export const scheduledJobsQueue = new Queue('scheduledJobs', REDIS_URL, queueOptions);

const allQueues = [
  replacementEngineQueue,
  dailyPayoutsQueue,
  kycVerificationQueue,
  idCardDispatchQueue,
  notificationsQueue,
  scheduledJobsQueue
];

allQueues.forEach((q) => {
  q.on('failed', async (job, error) => {
    const errorDetails = `Queue "${q.name}" failed executing Job ID ${job.id} (Name: "${job.name}"). Reason: ${error.message}. Payload: ${JSON.stringify(job.data)}`;
    console.error(`[QUEUE SECURITY FAILURE] ${errorDetails}`);
    await logSystemEvent('QUEUE_JOB_FAILURE', errorDetails);
  });
});
export { allQueues };
