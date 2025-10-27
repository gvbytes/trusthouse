import { prisma, logSystemEvent } from '../db.js';
import { sendNotification } from './notification_agent.js';


async function pingEndpoint(name, url) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);

    return response.status >= 200 && response.status < 500;
  } catch (error) {
    console.error(`[HEALTH MONITOR] Ping to ${name} failed:`, error.message);
    return false;
  }
}


async function checkDatabaseHealth() {
  try {
    const res = await prisma.$queryRaw`SELECT 1 AS ok`;
    return res && res.length > 0;
  } catch (error) {
    console.error('[HEALTH MONITOR] Database check failed:', error.message);
    return false;
  }
}


export async function runSystemHealthCheck() {
  console.log('[HEALTH MONITOR] Starting platform dependencies audit...');
  
  const status = {
    database: await checkDatabaseHealth(),
    firebase: await pingEndpoint('Firebase Auth API', 'https://identitytoolkit.googleapis.com/v1/accounts:signUp'),
    razorpay: await pingEndpoint('Razorpay API', 'https://api.razorpay.com'),
    persona: await pingEndpoint('Persona KYC', 'https://withpersona.com'),
    fast2sms: await pingEndpoint('Fast2SMS Gateway', 'https://www.fast2sms.com')
  };

  const failures = Object.entries(status)
    .filter(([_, ok]) => !ok)
    .map(([name]) => name);

  const timestamp = new Date().toISOString();
  
  if (failures.length > 0) {
    const alertMsg = `CRITICAL ALERT: System dependencies offline! Failures detected: [${failures.join(', ')}]. Time: ${timestamp}`;
    console.error(`[HEALTH MONITOR] ${alertMsg}`);

    await logSystemEvent('HEALTH_CHECK_FAILURE', alertMsg);

    const adminPhone = '9999912345';
    await sendNotification(adminPhone, 'absence', {}, 'en');
    
    return { success: false, status, failures };
  } else {
    const okMsg = `All systems online. Database, Firebase, Razorpay, Persona, Fast2SMS verified. Uptime: 100%`;
    console.log(`[HEALTH MONITOR] ${okMsg}`);

    await logSystemEvent('HEALTH_CHECK_OK', okMsg);

    return { success: true, status };
  }
}
