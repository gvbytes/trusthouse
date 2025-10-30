import { logSystemEvent } from '../db.js';

/**
 * Audit log middleware. Logs all POST, PUT, DELETE operations asynchronously
 * after response is sent. Filters out sensitive PII variables.
 */
export async function auditLogMiddleware(req, res, next) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const start = Date.now();
    
    // Listen for response completion to log details asynchronously
    res.on('finish', () => {
      const duration = Date.now() - start;
      const userId = req.user ? req.user.id : null;
      
      const payload = {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        status: res.statusCode,
        duration: `${duration}ms`,
        body: req.body ? { ...req.body } : {}
      };

      // Filter out sensitive data to protect PII
      if (payload.body) {
        delete payload.body.aadhaarNumber;
        delete payload.body.panNumber;
        delete payload.body.bankAccount;
        delete payload.body.otp;
        delete payload.body.password;
        delete payload.body.token;
      }

      const eventType = `API_${req.method}_${req.originalUrl.split('/')[2]?.toUpperCase() || 'ACTION'}`;

      logSystemEvent(
        eventType,
        JSON.stringify(payload),
        userId
      ).catch((err) => {
        console.error('[AUDIT MIDDLEWARE ERROR] Failed to write audit log:', err.message);
      });
    });
  }
  next();
}
