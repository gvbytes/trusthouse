import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error('[REDIS] Critical Error: REDIS_URL environment variable is missing.');
}

const connectionOptions = {
  maxRetriesPerRequest: null,
  tls: {
    rejectUnauthorized: false
  }
};

let redis = null;

try {
  redis = new Redis(REDIS_URL, connectionOptions);

  redis.on('connect', () => {
    console.log('[REDIS] Connection health check: SUCCESS. Upstash Redis connection established.');
  });

  redis.on('error', (err) => {
    console.error('[REDIS] Connection health check: FAILURE. Error details:', err.message);
  });
} catch (error) {
  console.error('[REDIS] Failed to initialize ioredis client:', error.message);
}

export default redis;
export { connectionOptions };
