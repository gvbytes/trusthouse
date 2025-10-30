import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error('[REDIS] Critical Error: REDIS_URL environment variable is missing.');
}

// ioredis connection options tuned for managed/serverless providers like Upstash and Bull compatibility
const connectionOptions = {
  maxRetriesPerRequest: null, // Required by Bull.js
  tls: {
    rejectUnauthorized: false // Bypasses TLS certificate verification checks in dev/sandbox
  }
};

let redis = null;

try {
  // If the protocol isn't already rediss, we can parse and apply TLS. 
  // Upstash URL generally uses rediss:// format. If not, tls options in options object force secure connection.
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
