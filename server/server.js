import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { initDb, dbRun, dbGet, dbAll, prisma, logSystemEvent } from './db.js';
import { encrypt, decrypt } from './crypto_helper.js';
import { requestOTP, verifyOTP, generateToken, authenticateToken, requireRole } from './auth.js';
import { sendNotification } from './agents/notification_agent.js';
import { createPersonaInquiry, verifyPersonaSignature, processPersonaWebhook } from './agents/kyc_agent.js';
import { triggerReplacementEngine } from './agents/replacement_agent.js';
import { generateWorkerIdCard } from './agents/idcard_agent.js';
import { processDailyPayouts } from './agents/payout_agent.js';
import { runSystemHealthCheck } from './agents/health_agent.js';
import { initStorage } from './config/storage.js';
import redis from './config/redis.js';
import fs from 'fs';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import { 
  replacementEngineQueue, 
  dailyPayoutsQueue, 
  kycVerificationQueue, 
  idCardDispatchQueue, 
  notificationsQueue, 
  scheduledJobsQueue,
  allQueues
} from './queues/index.js';
import { auditLogMiddleware } from './middleware/audit.js';
import { 
  validate, 
  otpRequestSchema, 
  otpVerifySchema, 
  firebaseLoginSchema, 
  kycInitiateSchema, 
  attendanceSchema, 
  bookingCreateSchema, 
  ratingSubmitSchema, 
  adminPayoutRunSchema,
  consentSchema
} from './middleware/validate.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://identitytoolkit.googleapis.com"],
      connectSrc: ["'self'", "https://identitytoolkit.googleapis.com"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:5173';
app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.use(compression());

app.use(morgan('combined'));

app.use(auditLogMiddleware);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { 
    success: false, 
    error: { 
      code: 'TOO_MANY_REQUESTS', 
      message: 'Too many requests from this IP, please try again later.' 
    } 
  }
});
app.use('/api', globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { 
    success: false, 
    error: { 
      code: 'AUTH_RATE_LIMIT', 
      message: 'Too many auth requests. Please slow down.' 
    } 
  }
});
app.use('/api/auth', authLimiter);

const publicVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { 
    success: false, 
    error: { 
      code: 'VERIFY_RATE_LIMIT', 
      message: 'Too many verification requests. Please slow down.' 
    } 
  }
});

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullAdapter(replacementEngineQueue),
    new BullAdapter(dailyPayoutsQueue),
    new BullAdapter(kycVerificationQueue),
    new BullAdapter(idCardDispatchQueue),
    new BullAdapter(notificationsQueue),
    new BullAdapter(scheduledJobsQueue)
  ],
  serverAdapter: serverAdapter
});

app.use('/admin/queues', authenticateToken, requireRole(['admin']), serverAdapter.getRouter());


notificationsQueue.process('send', async (job) => {
  const { phone, templateKey, variables, lang } = job.data;
  console.log(`[QUEUE PROCESSOR] Processing Notification job to ${phone}`);
  await sendNotification(phone, templateKey, variables, lang);
  return { status: 'success' };
});

notificationsQueue.process('test', async (job) => {
  console.log(`[QUEUE PROCESSOR] Processing Job ID ${job.id} ("${job.name}")`);
  console.log(`[QUEUE PROCESSOR] Payload received: "${job.data.message}"`);
  return { status: 'success', processedAt: new Date().toISOString() };
});

replacementEngineQueue.process('findReplacement', async (job) => {
  const { bookingId, absentWorkerId } = job.data;
  console.log(`[QUEUE PROCESSOR] Processing Replacement Engine job for booking ${bookingId}`);
  await triggerReplacementEngine(bookingId, absentWorkerId);
  return { status: 'success' };
});

kycVerificationQueue.process('processWebhook', async (job) => {
  console.log(`[QUEUE PROCESSOR] Processing KYC Webhook job`);
  await processPersonaWebhook(job.data);
  return { status: 'success' };
});

idCardDispatchQueue.process('generateIdCard', async (job) => {
  const { workerId } = job.data;
  console.log(`[QUEUE PROCESSOR] Processing ID Card Generation job for worker ${workerId}`);
  const worker = await prisma.worker.findUnique({ where: { id: workerId } });
  if (worker) {
    await generateWorkerIdCard(worker);
  }
  return { status: 'success' };
});

dailyPayoutsQueue.process('runPayouts', async (job) => {
  const { date } = job.data;
  console.log(`[QUEUE PROCESSOR] Processing Payouts job for date ${date}`);
  await processDailyPayouts(date);
  return { status: 'success' };
});

scheduledJobsQueue.process(async (job) => {
  console.log(`[QUEUE PROCESSOR] Running scheduled operation: "${job.name}"`);
  
  if (job.name === 'dailyPayout') {
    const todayStr = new Date().toISOString().split('T')[0];
    await processDailyPayouts(todayStr);
  } else if (job.name === 'metricsSnapshot') {
    const totalWorkers = await prisma.worker.count();
    const totalHouseholds = await prisma.household.count();
    const activeAssignments = await prisma.assignment.count({ where: { status: 'ACTIVE' } });
    
    const totalRevenue = await prisma.payment.aggregate({
      _sum: { commission: true },
      where: { type: 'WAGE', status: 'SUCCESS' }
    }).then(r => r._sum.commission || 0);

    const totalPayouts = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { type: 'PAYOUT', status: 'SUCCESS' }
    }).then(r => r._sum.amount || 0);

    await prisma.metricsSnapshot.create({
      data: {
        totalWorkers,
        totalHouseholds,
        activeAssignments,
        totalRevenue,
        totalPayouts,
        replacementSuccessRate: 100.0
      }
    });
    console.log(`[QUEUE PROCESSOR] Saved daily metrics snapshot successfully.`);
  } else {
    console.log(`[QUEUE PROCESSOR] Mock execution of operation "${job.name}" completed.`);
  }
  return { status: 'success' };
});

async function setupScheduledJobs() {
  if (!redis) {
    console.warn('[QUEUES WARNING] Redis is disconnected, skipping cron registration.');
    return;
  }
  try {
    const repeatableJobs = await scheduledJobsQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await scheduledJobsQueue.removeRepeatableByKey(job.key);
    }

    console.log('[QUEUES] Registering 10 scheduled operations on repeatable cron schedules...');

    const jobs = [
      { name: 'dailyConfirmation', cron: '30 3 * * *' },
      { name: 'absenceCheck', cron: '30 4 * * *' },
      { name: 'absenceEscalation', cron: '30 5 * * *' },
      { name: 'dailyPayout', cron: '30 12 * * *' },
      { name: 'ratingRequest', cron: '30 14 * * *' },
      { name: 'loyaltyCheck', cron: '30 2 * * 1' },
      { name: 'cardExpiryCheck', cron: '30 3 1 * *' },
      { name: 'metricsSnapshot', cron: '29 18 * * *' },
      { name: 'weeklyReport', cron: '30 14 * * 0' },
      { name: 'lowRatingAlert', cron: '30 15 * * *' }
    ];

    for (const j of jobs) {
      await scheduledJobsQueue.add(j.name, {}, { repeat: { cron: j.cron } });
    }
    console.log('[QUEUES] All 10 cron operations successfully registered.');
  } catch (err) {
    console.error('[QUEUES ERROR] Failed to register cron operations:', err.message);
  }
}

setupScheduledJobs().catch(console.error);




app.get('/api/health', async (req, res) => {
  try {
    const health = await runSystemHealthCheck();
    
    const queueStatus = {};
    for (const q of allQueues) {
      try {
        await q.client.ping();
        queueStatus[q.name] = 'ONLINE';
      } catch (err) {
        queueStatus[q.name] = 'OFFLINE';
      }
    }

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        status: health.success ? 'HEALTHY' : 'DEGRADED',
        dependencies: health.status,
        queues: queueStatus
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: {
        code: 'HEALTH_CHECK_ERROR',
        message: err.message
      }
    });
  }
});




app.post('/api/auth/otp/request', validate(otpRequestSchema), async (req, res) => {
  const { phone } = req.body;
  try {
    const rawOtp = await requestOTP(phone);
    await sendNotification(phone, 'otp', { otp: rawOtp }, 'hi');
    res.json({ success: true, message: 'OTP sent successfully.' });
  } catch (error) {
    res.status(429).json({
      success: false,
      error: {
        code: 'OTP_REQUEST_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/auth/otp/verify', validate(otpVerifySchema), async (req, res) => {
  const { phone, otp, role, name, skills, lat, lng } = req.body;

  try {
    await verifyOTP(phone, otp);

    let user = await prisma.user.findUnique({
      where: { phone }
    });
    
    if (!user) {
      if (!role || !['worker', 'household'].includes(role) || !name) {
        return res.json({ 
          success: true,
          data: {
            needsRegistration: true, 
            message: 'OTP verified. Profile registration required.' 
          }
        });
      }

      const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
      user = await prisma.user.create({
        data: {
          id: userId,
          phone,
          role: role === 'worker' ? 'WORKER' : 'HOUSEHOLD'
        }
      });

      if (role === 'worker') {
        const workerId = `w_${crypto.randomBytes(8).toString('hex')}`;
        await prisma.worker.create({
          data: {
            id: workerId,
            userId: userId,
            name,
            skills: skills ? skills.split(',').map(s => s.toUpperCase().trim()) : [],
            rating: 5.0,
            trustScore: 50.0,
            hourlyRate: 100.0,
            kycStatus: 'PENDING',
            lat: lat || 28.6139,
            lng: lng || 77.2090
          }
        });
      } else if (role === 'household') {
        const householdId = `h_${crypto.randomBytes(8).toString('hex')}`;
        await prisma.household.create({
          data: {
            id: householdId,
            userId: userId,
            name,
            trustScore: 50.0,
            plan: 'BASIC',
            lat: lat || 28.6139,
            lng: lng || 77.2090
          }
        });
      }
    }

    const token = generateToken(user);
    res.json({
      success: true,
      data: { token, user }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: {
        code: 'OTP_VERIFICATION_FAILED',
        message: error.message
      }
    });
  }
});

app.post('/api/auth/firebase-login', validate(firebaseLoginSchema), async (req, res) => {
  const { email, name, role, firebaseUid } = req.body;

  try {
    let user = await prisma.user.findUnique({
      where: { phone: email }
    });

    if (!user) {
      const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
      const mappedRole = role === 'admin' ? 'ADMIN' : 'HOUSEHOLD';
      
      user = await prisma.user.create({
        data: {
          id: userId,
          phone: email,
          email: email,
          role: mappedRole
        }
      });

      if (mappedRole === 'HOUSEHOLD') {
        const householdId = `h_${crypto.randomBytes(8).toString('hex')}`;
        await prisma.household.create({
          data: {
            id: householdId,
            userId: userId,
            name: name || 'New Household',
            trustScore: 50.0,
            plan: 'BASIC',
            lat: 28.6139,
            lng: 77.2090
          }
        });
      }
    }

    const token = generateToken(user);
    res.json({
      success: true,
      data: { token, user }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'FIREBASE_LOGIN_ERROR',
        message: error.message
      }
    });
  }
});

app.post('/api/auth/consent', authenticateToken, validate(consentSchema), async (req, res) => {
  try {
    const timestamp = new Date().toISOString();
    await logSystemEvent(
      'DPDP_CONSENT_GRANTED',
      `User ${req.user.phone} agreed to DPDP Act privacy consent terms at ${timestamp}`,
      req.user.id
    );
    res.json({
      success: true,
      message: 'DPDP Act privacy consent successfully recorded.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'CONSENT_RECORD_ERROR',
        message: error.message
      }
    });
  }
});



app.get('/api/workers/profile', authenticateToken, requireRole(['worker']), async (req, res) => {
  try {
    const worker = await prisma.worker.findUnique({
      where: { userId: req.user.id },
      include: { user: true }
    });

    if (!worker) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Worker profile not found.'
        }
      });
    }

    let rawAadhaar = null;
    if (worker.aadhaarLast4) {
      rawAadhaar = decrypt(worker.aadhaarLast4);
    }

    res.json({
      success: true,
      data: {
        ...worker,
        phone: worker.user.phone,
        aadhaarNumber: rawAadhaar ? `XXXX-XXXX-${rawAadhaar.slice(-4)}` : null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.'
      }
    });
  }
});

app.post('/api/workers/kyc/initiate', authenticateToken, requireRole(['worker']), validate(kycInitiateSchema), async (req, res) => {
  const { aadhaarNumber } = req.body;

  try {
    const worker = await prisma.worker.findUnique({
      where: { userId: req.user.id }
    });
    if (!worker) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Worker profile not found.'
        }
      });
    }

    const encrypted = encrypt(aadhaarNumber);

    await prisma.worker.update({
      where: { id: worker.id },
      data: {
        aadhaarLast4: encrypted
      }
    });

    const kycSession = await createPersonaInquiry(worker.id, worker.name);
    
    res.json({
      success: true,
      data: {
        inquiryId: kycSession.inquiryId,
        sessionUrl: kycSession.sessionUrl
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'KYC_INITIATION_ERROR',
        message: error.message
      }
    });
  }
});

app.post('/api/workers/attendance', authenticateToken, requireRole(['worker']), validate(attendanceSchema), async (req, res) => {
  const { action, bookingId, date } = req.body;
  const todayStr = date || new Date().toISOString().split('T')[0];

  try {
    const worker = await prisma.worker.findUnique({
      where: { userId: req.user.id },
      include: { user: true }
    });
    if (!worker) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Worker profile not found.'
        }
      });
    }

    const attendanceId = `${bookingId}-${todayStr}`;
    const nowTime = new Date();

    if (action === 'checkin') {
      await prisma.attendance.upsert({
        where: { id: attendanceId },
        update: {
          checkedIn: nowTime,
          status: 'PENDING'
        },
        create: {
          id: attendanceId,
          assignmentId: bookingId,
          workerId: worker.id,
          date: new Date(todayStr),
          checkedIn: nowTime,
          status: 'PENDING'
        }
      });
      await sendNotification(worker.user.phone, 'checkin', { time: nowTime.toLocaleTimeString() }, 'hi');
      res.json({ success: true, message: 'Check-in recorded.' });
    } else if (action === 'checkout') {
      await prisma.attendance.update({
        where: { id: attendanceId },
        data: {
          checkedOut: nowTime,
          status: 'PRESENT'
        }
      });
      await sendNotification(worker.user.phone, 'checkout', { time: nowTime.toLocaleTimeString() }, 'hi');
      res.json({ success: true, message: 'Check-out recorded.' });
    } else if (action === 'absent') {
      await prisma.attendance.upsert({
        where: { id: attendanceId },
        update: {
          status: 'ABSENT'
        },
        create: {
          id: attendanceId,
          assignmentId: bookingId,
          workerId: worker.id,
          date: new Date(todayStr),
          status: 'ABSENT'
        }
      });

      res.json({ success: true, message: 'Absence recorded. Replacement routing initiated.' });

      await replacementEngineQueue.add('findReplacement', { bookingId, absentWorkerId: worker.id });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'ATTENDANCE_RECORD_ERROR',
        message: error.message
      }
    });
  }
});

app.post('/api/workers/toggle-availability', authenticateToken, requireRole(['worker']), async (req, res) => {
  try {
    const worker = await prisma.worker.findUnique({ where: { userId: req.user.id } });
    if (!worker) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Worker profile not found.'
        }
      });
    }

    const updated = await prisma.worker.update({
      where: { id: worker.id },
      data: { onCall: !worker.onCall }
    });

    res.json({
      success: true,
      data: { onCall: updated.onCall },
      message: `Availability successfully changed to ${updated.onCall ? 'Available' : 'Unavailable'}.`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message
      }
    });
  }
});

app.get('/api/workers/idcard', authenticateToken, requireRole(['worker']), async (req, res) => {
  try {
    const worker = await prisma.worker.findUnique({
      where: { userId: req.user.id }
    });

    if (!worker) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Worker profile not found.'
        }
      });
    }

    if (worker.kycStatus !== 'VERIFIED') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'KYC_NOT_VERIFIED',
          message: 'KYC must be verified before retrieving your ID Card.'
        }
      });
    }

    const idCardUrl = await generateWorkerIdCard(worker);

    res.json({
      success: true,
      data: { idCardUrl }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'ID_CARD_GENERATION_FAILED',
        message: error.message
      }
    });
  }
});

app.get('/api/workers/earnings', authenticateToken, requireRole(['worker']), async (req, res) => {
  try {
    const worker = await prisma.worker.findUnique({
      where: { userId: req.user.id }
    });
    if (!worker) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Worker profile not found.' }
      });
    }

    const payouts = await prisma.payment.findMany({
      where: { workerId: worker.id, type: 'PAYOUT' },
      orderBy: { createdAt: 'desc' }
    });

    const totalEarned = payouts.reduce((sum, p) => sum + p.amount, 0);
    const totalCommission = payouts.reduce((sum, p) => sum + p.commission, 0);
    const totalGst = payouts.reduce((sum, p) => sum + p.gst, 0);

    res.json({
      success: true,
      data: {
        totalEarned,
        totalCommission,
        totalGst,
        payouts
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

app.get('/api/workers/assignments', authenticateToken, requireRole(['worker']), async (req, res) => {
  try {
    const worker = await prisma.worker.findUnique({
      where: { userId: req.user.id }
    });
    if (!worker) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Worker profile not found.' }
      });
    }

    const assignments = await prisma.assignment.findMany({
      where: { workerId: worker.id },
      include: { household: true },
      orderBy: { startDate: 'desc' }
    });

    res.json({
      success: true,
      data: assignments
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

app.get('/api/workers/benefits', authenticateToken, requireRole(['worker']), async (req, res) => {
  try {
    const worker = await prisma.worker.findUnique({
      where: { userId: req.user.id }
    });
    if (!worker) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Worker profile not found.' }
      });
    }

    let currentFeeRate = 2.0;
    if (worker.trustScore >= 85) currentFeeRate = 0.5;
    else if (worker.trustScore >= 70) currentFeeRate = 1.0;
    else if (worker.trustScore >= 60) currentFeeRate = 1.5;

    res.json({
      success: true,
      data: {
        trustScore: worker.trustScore,
        currentFeeRate,
        nextDiscountMilestone: worker.trustScore < 85 ? `Reach trust score of ${worker.trustScore < 60 ? '60' : worker.trustScore < 70 ? '70' : '85'} to reduce fee rate.` : 'Maximum platform fee discount achieved.',
        equityPoolShare: (worker.trustScore * 12.50).toFixed(2) + ' INR (Accrued)',
        insuranceCoverStatus: worker.trustScore >= 50 ? 'ACTIVE (Continuity Cover Plus)' : 'INACTIVE'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});



app.get('/api/households/profile', authenticateToken, requireRole(['household']), async (req, res) => {
  try {
    const household = await prisma.household.findUnique({
      where: { userId: req.user.id },
      include: { user: true }
    });

    if (!household) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Household profile not found.'
        }
      });
    }
    res.json({
      success: true,
      data: {
        ...household,
        phone: household.user.phone
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.'
      }
    });
  }
});

app.get('/api/households/workers/nearby', authenticateToken, requireRole(['household']), async (req, res) => {
  try {
    const household = await prisma.household.findUnique({
      where: { userId: req.user.id }
    });
    if (!household) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Household not found.'
        }
      });
    }

    const cacheKey = `nearby_workers:${household.id}`;
    if (redis) {
      try {
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
          console.log(`[REDIS] Cache Hit for nearby workers of household ${household.id}`);
          return res.json({
            success: true,
            data: JSON.parse(cachedData)
          });
        }
      } catch (cacheErr) {
        console.error('[REDIS ERROR] Nearby cache get failed:', cacheErr.message);
      }
    }

    const workers = await prisma.worker.findMany({
      where: { kycStatus: 'VERIFIED' }
    });
    
    const sorted = workers.map(w => {
      const R = 6371;
      const dLat = ((w.lat - household.lat) * Math.PI) / 180;
      const dLon = ((w.lng - household.lng) * Math.PI) / 180;
      const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(household.lat*Math.PI/180)*Math.cos(w.lat*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;
      return { ...w, distance };
    }).sort((a, b) => a.distance - b.distance);

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(sorted), 'EX', 300);
        console.log(`[REDIS] Cached nearby workers search for household ${household.id}`);
      } catch (cacheErr) {
        console.error('[REDIS ERROR] Nearby cache set failed:', cacheErr.message);
      }
    }

    res.json({
      success: true,
      data: sorted
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'NEARBY_WORKERS_ERROR',
        message: error.message
      }
    });
  }
});

app.post('/api/households/bookings/create', authenticateToken, requireRole(['household']), validate(bookingCreateSchema), async (req, res) => {
  const { workerId } = req.body;

  try {
    const household = await prisma.household.findUnique({ where: { userId: req.user.id } });
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });

    if (!household || !worker) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Household or Worker not found.'
        }
      });
    }

    const bookingId = `b_${crypto.randomBytes(8).toString('hex')}`;
    
    const amount = worker.hourlyRate * 8;
    const commission = amount * 0.014;
    const totalAmount = amount + commission;

    let razorpayOrderId = `order_${crypto.randomBytes(8).toString('hex')}`;

    if (razorpay) {
      try {
        const order = await razorpay.orders.create({
          amount: Math.round(totalAmount * 100),
          currency: 'INR',
          receipt: bookingId,
          payment_capture: 1
        });
        razorpayOrderId = order.id;
      } catch (err) {
        console.error('[PAYMENT ERROR] Razorpay order creation failed:', err.message);
      }
    }

    await prisma.assignment.create({
      data: {
        id: bookingId,
        householdId: household.id,
        workerId: worker.id,
        status: 'ACTIVE',
        hourlyRate: worker.hourlyRate,
        commissionWorkerRate: 1.5,
        commissionHouseholdRate: 1.4
      }
    });

    const paymentId = `pay_${crypto.randomBytes(8).toString('hex')}`;
    await prisma.payment.create({
      data: {
        id: paymentId,
        householdId: household.id,
        amount: totalAmount,
        type: 'WAGE',
        status: 'PENDING',
        razorpayOrderId: razorpayOrderId,
        commission: commission,
        gst: commission * 0.18
      }
    });

    res.json({
      success: true,
      data: {
        bookingId,
        razorpayOrderId,
        amount: totalAmount,
        keyId: RAZORPAY_KEY_ID
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'BOOKING_CREATION_ERROR',
        message: error.message
      }
    });
  }
});

app.get('/api/households/bookings', authenticateToken, requireRole(['household']), async (req, res) => {
  try {
    const household = await prisma.household.findUnique({ where: { userId: req.user.id } });
    if (!household) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PROFILE_NOT_FOUND',
          message: 'Household not found.'
        }
      });
    }

    const bookings = await prisma.assignment.findMany({
      where: {
        householdId: household.id,
        status: 'ACTIVE'
      },
      include: {
        worker: true,
        attendances: {
          orderBy: { date: 'desc' },
          take: 1
        }
      }
    });

    const mapped = bookings.map(b => ({
      id: b.id,
      householdId: b.householdId,
      workerId: b.workerId,
      status: b.status.toLowerCase(),
      createdAt: b.createdAt,
      worker_name: b.worker.name,
      worker_skills: b.worker.skills.join(','),
      worker_rating: b.worker.rating,
      today_attendance: b.attendances[0]?.status.toLowerCase() || null
    }));

    res.json({
      success: true,
      data: mapped
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'BOOKINGS_FETCH_ERROR',
        message: error.message
      }
    });
  }
});

app.post('/api/households/subscription/checkout', authenticateToken, requireRole(['household']), async (req, res) => {
  const { plan } = req.body;
  try {
    const household = await prisma.household.findUnique({
      where: { userId: req.user.id }
    });
    if (!household) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Household profile not found.' }
      });
    }

    const amount = plan === 'PLUS' ? 999.00 : 0.00;
    const razorpaySubscriptionId = `sub_${crypto.randomBytes(8).toString('hex')}`;

    await prisma.household.update({
      where: { id: household.id },
      data: { plan: plan === 'PLUS' ? 'PLUS' : 'BASIC' }
    });

    await prisma.payment.create({
      data: {
        id: `pay_${crypto.randomBytes(8).toString('hex')}`,
        householdId: household.id,
        amount: amount,
        type: 'SUBSCRIPTION',
        status: 'SUCCESS',
        razorpayOrderId: razorpaySubscriptionId,
        createdAt: new Date()
      }
    });

    res.json({
      success: true,
      data: {
        subscriptionId: razorpaySubscriptionId,
        plan: plan,
        status: 'ACTIVE'
      },
      message: `Successfully upgraded to ${plan} plan.`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

app.post('/api/ratings', authenticateToken, validate(ratingSubmitSchema), async (req, res) => {
  const { assignmentId, type, score, review } = req.body;
  
  try {
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { worker: true, household: true }
    });

    if (!assignment) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Assignment not found.' }
      });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    
    let fromWorkerId = null;
    let toWorkerId = null;
    let fromHouseholdId = null;
    let toHouseholdId = null;

    if (type === 'worker_to_household') {
      if (assignment.worker.userId !== user.id) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only the assigned worker can submit this rating.' }
        });
      }
      fromWorkerId = assignment.workerId;
      toHouseholdId = assignment.householdId;
    } else if (type === 'household_to_worker') {
      if (assignment.household.userId !== user.id) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only the assigned household can submit this rating.' }
        });
      }
      fromHouseholdId = assignment.householdId;
      toWorkerId = assignment.workerId;
    }

    const ratingId = `r_${crypto.randomBytes(8).toString('hex')}`;
    const rating = await prisma.rating.create({
      data: {
        id: ratingId,
        assignmentId,
        type: type === 'worker_to_household' ? 'WORKER_TO_HOUSEHOLD' : 'HOUSEHOLD_TO_WORKER',
        score,
        review,
        fromWorkerId,
        toWorkerId,
        fromHouseholdId,
        toHouseholdId
      }
    });

    if (type === 'household_to_worker') {
      const allRatings = await prisma.rating.findMany({
        where: { toWorkerId: assignment.workerId }
      });
      const avgRating = allRatings.reduce((sum, r) => sum + r.score, 0) / allRatings.length;
      
      let trustDelta = score >= 4 ? 2.0 : score <= 2 ? -5.0 : 0;
      const newTrustScore = Math.min(100, Math.max(0, assignment.worker.trustScore + trustDelta));

      await prisma.worker.update({
        where: { id: assignment.workerId },
        data: {
          rating: avgRating,
          trustScore: newTrustScore
        }
      });

      await logSystemEvent('RATING_RECALCULATED', `Recalculated worker ${assignment.workerId} rating: ${avgRating.toFixed(2)}. New Trust Score: ${newTrustScore}`);
    } else if (type === 'worker_to_household') {
      const allRatings = await prisma.rating.findMany({
        where: { toHouseholdId: assignment.householdId }
      });
      const avgRating = allRatings.reduce((sum, r) => sum + r.score, 0) / allRatings.length;

      let trustDelta = score >= 4 ? 2.0 : score <= 2 ? -5.0 : 0;
      const newTrustScore = Math.min(100, Math.max(0, assignment.household.trustScore + trustDelta));

      await prisma.household.update({
        where: { id: assignment.householdId },
        data: {
          trustScore: newTrustScore
        }
      });

      await logSystemEvent('RATING_RECALCULATED', `Recalculated household ${assignment.householdId} trust score: ${newTrustScore}`);
    }

    res.json({
      success: true,
      data: rating,
      message: 'Rating submitted successfully and averages updated.'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});



app.get('/api/verify/:workerCode', publicVerifyLimiter, async (req, res) => {
  const { workerCode } = req.params;
  const cacheKey = `verify_worker:${workerCode}`;

  if (redis) {
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        console.log(`[REDIS] Cache Hit for verify worker ${workerCode}`);
        return res.json({
          success: true,
          data: JSON.parse(cachedData)
        });
      }
    } catch (cacheErr) {
      console.error('[REDIS ERROR] Verify cache get failed:', cacheErr.message);
    }
  }

  try {
    const worker = await prisma.worker.findFirst({
      where: {
        OR: [
          { id: workerCode },
          { userId: workerCode }
        ]
      }
    });

    if (!worker) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Identity record not found.'
        }
      });
    }

    const responseData = {
      verified: worker.kycStatus === 'VERIFIED',
      name: worker.name,
      skills: worker.skills,
      rating: worker.rating,
      trustScore: worker.trustScore,
      status: worker.kycStatus
    };

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 3600);
        console.log(`[REDIS] Cached verify status for worker ${workerCode}`);
      } catch (cacheErr) {
        console.error('[REDIS ERROR] Verify cache set failed:', cacheErr.message);
      }
    }

    res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'VERIFY_ERROR',
        message: 'Server error processing verification query.'
      }
    });
  }
});



app.post('/api/webhooks/persona', async (req, res) => {
  const signature = req.headers['persona-signature'];
  const rawBody = req.rawBody;

  if (!verifyPersonaSignature(signature, rawBody)) {
    console.warn('[SECURITY WARNING] Rejecting unauthorized Persona webhook signature.');
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED_WEBHOOK',
        message: 'Invalid signature verification'
      }
    });
  }

  try {
    await processPersonaWebhook(req.body);
    res.json({ success: true, message: 'Webhook processed successfully.' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'WEBHOOK_ERROR',
        message: error.message
      }
    });
  }
});

app.post('/api/webhooks/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.rawBody;

  if (!signature || !RAZORPAY_KEY_SECRET) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Signature parameters missing'
      }
    });
  }

  const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '');
  const computed = hmac.update(rawBody).digest('hex');

  if (signature !== computed) {
    console.warn('[SECURITY WARNING] Rejecting unauthorized Razorpay webhook signature.');
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED_WEBHOOK',
        message: 'Invalid signature verification'
      }
    });
  }

  const event = req.body;
  console.log(`[PAYMENT WEBHOOK] Received Razorpay event: ${event.event}`);

  try {
    if (event.event === 'order.paid' || event.event === 'payment.captured') {
      const orderId = event.payload.order?.entity?.id || event.payload.payment?.entity?.order_id;
      const paymentId = event.payload.payment?.entity?.id;

      if (orderId && paymentId) {
        const existingPayment = await prisma.payment.findUnique({
          where: { razorpayPaymentId: paymentId }
        });

        if (existingPayment) {
          console.log(`[PAYMENT WEBHOOK] Payment ${paymentId} already processed. Skipping.`);
          return res.json({ success: true, message: 'Already processed' });
        }

        const paymentRecord = await prisma.payment.findFirst({
          where: { razorpayOrderId: orderId }
        });

        if (paymentRecord) {
          await prisma.payment.update({
            where: { id: paymentRecord.id },
            data: {
              status: 'SUCCESS',
              razorpayPaymentId: paymentId
            }
          });
          console.log(`[PAYMENT WEBHOOK] Order ${orderId} / Payment ${paymentId} marked as SUCCESS.`);
        }
      }
    } else if (event.event === 'subscription.charged') {
      const subscriptionId = event.payload.subscription.entity.id;
      const paymentId = event.payload.payment.entity.id;

      const existingPayment = await prisma.payment.findUnique({
        where: { razorpayPaymentId: paymentId }
      });

      if (!existingPayment) {
        const paymentRecord = await prisma.payment.findFirst({
          where: { razorpayOrderId: subscriptionId }
        });

        if (paymentRecord && paymentRecord.householdId) {
          await prisma.payment.update({
            where: { id: paymentRecord.id },
            data: {
              status: 'SUCCESS',
              razorpayPaymentId: paymentId
            }
          });

          await prisma.household.update({
            where: { id: paymentRecord.householdId },
            data: { plan: 'PLUS' }
          });
          console.log(`[PAYMENT WEBHOOK] Subscription ${subscriptionId} charged. Household ${paymentRecord.householdId} upgraded to PLUS.`);
        }
      }
    }
  } catch (webhookErr) {
    console.error('[PAYMENT WEBHOOK ERROR]', webhookErr.message);
  }

  res.json({ success: true, message: 'Webhook processed successfully.' });
});

app.post('/api/webhooks/sms-reply', async (req, res) => {
  const { phone, text } = req.body;
  
  if (!phone || !text) {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Missing phone or text parameters.' }
    });
  }

  try {
    const worker = await prisma.worker.findFirst({
      where: { user: { phone } },
      include: { user: true }
    });

    if (!worker) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Worker profile not found for this phone number.' }
      });
    }

    console.log(`[SMS WEBHOOK] Received reply from ${phone} (${worker.name}): "${text}"`);

    const activeReplacement = await prisma.replacement.findFirst({
      where: {
        candidateWorkerId: worker.id,
        status: 'PENDING'
      },
      include: {
        assignment: {
          include: {
            household: { include: { user: true } }
          }
        }
      }
    });

    if (!activeReplacement) {
      return res.json({
        success: true,
        message: 'No active replacement offer found for this candidate.'
      });
    }

    const answer = text.trim().toUpperCase();
    if (answer === 'YES') {
      await prisma.replacement.update({
        where: { id: activeReplacement.id },
        data: {
          status: 'CONFIRMED',
          responseTime: new Date()
        }
      });

      await prisma.assignment.update({
        where: { id: activeReplacement.assignmentId },
        data: { workerId: worker.id }
      });

      await logSystemEvent(
        'REPLACEMENT_SUCCESS',
        `Booking ${activeReplacement.assignmentId} successfully replaced with candidate ${worker.id}`
      );

      await sendNotification(worker.user.phone, 'replacement', { name: activeReplacement.assignment.household.name, rating: worker.rating.toString() }, 'hi');
      await sendNotification(activeReplacement.assignment.household.user.phone, 'replacement', { name: worker.name, rating: worker.rating.toFixed(1) }, 'en');

      if (redis) {
        await redis.set(`replacement:response:${activeReplacement.id}`, 'YES', 'EX', 3600);
      }
    } else {
      await prisma.replacement.update({
        where: { id: activeReplacement.id },
        data: {
          status: 'REJECTED',
          responseTime: new Date()
        }
      });

      if (redis) {
        await redis.set(`replacement:response:${activeReplacement.id}`, 'NO', 'EX', 3600);
      }
    }

    res.json({ success: true, message: `SMS reply "${answer}" successfully processed.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});



app.post('/api/admin/payouts/run', authenticateToken, requireRole(['admin']), validate(adminPayoutRunSchema), async (req, res) => {
  const { date } = req.body;
  const targetDate = date || new Date().toISOString().split('T')[0];
  try {
    await processDailyPayouts(targetDate);
    res.json({ success: true, message: `Payout processing completed for ${targetDate}` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'PAYOUT_RUN_ERROR',
        message: error.message
      }
    });
  }
});

app.get('/api/admin/health/check', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const results = await runSystemHealthCheck();
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'HEALTH_CHECK_ERROR',
        message: error.message
      }
    });
  }
});

app.get('/api/mock-storage/:bucket/:file', async (req, res) => {
  const { bucket, file } = req.params;
  const filePath = path.resolve(__dirname, '../storage', bucket, file);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Mock file not found'
      }
    });
  }
});

app.post('/api/test/redis', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const job = await notificationsQueue.add('test', { message: 'Redis is working' });
    res.json({ 
      success: true, 
      data: {
        message: 'Test job successfully added to notifications queue.', 
        jobId: job.id 
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'REDIS_TEST_ERROR',
        message: error.message
      }
    });
  }
});

app.get('/api/admin/logs', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const mappedLogs = logs.map(l => ({
      id: l.id,
      event_type: l.action,
      details: l.details,
      created_at: l.createdAt
    }));
    res.json({
      success: true,
      data: mappedLogs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: 'LOGS_FETCH_ERROR',
        message: error.message
      }
    });
  }
});

app.get('/api/admin/metrics', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const totalWorkers = await prisma.worker.count();
    const totalHouseholds = await prisma.household.count();
    const activeAssignments = await prisma.assignment.count({ where: { status: 'ACTIVE' } });
    
    const kycStats = await prisma.worker.groupBy({
      by: ['kycStatus'],
      _count: true
    });
    
    const totalPayouts = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { type: 'PAYOUT', status: 'SUCCESS' }
    }).then(r => r._sum.amount || 0);

    const totalRevenue = await prisma.payment.aggregate({
      _sum: { commission: true },
      where: { type: 'WAGE', status: 'SUCCESS' }
    }).then(r => r._sum.commission || 0);

    res.json({
      success: true,
      data: {
        totalWorkers,
        totalHouseholds,
        activeAssignments,
        totalPayouts,
        totalRevenue,
        kycStats
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

app.get('/api/admin/kyc-queue', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      where: {
        kycStatus: { in: ['PENDING', 'NEEDS_REVIEW'] }
      },
      include: { user: true }
    });
    res.json({
      success: true,
      data: workers
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

app.get('/api/admin/disputes', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const lowRatings = await prisma.rating.findMany({
      where: { score: { lte: 2.0 } },
      include: { assignment: { include: { worker: true, household: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const activeReplacements = await prisma.replacement.findMany({
      where: { status: { in: ['PENDING', 'REJECTED', 'EXHAUSTED'] } },
      include: { absentWorker: true, candidateWorker: true, household: true },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: {
        lowRatings,
        activeReplacements
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

app.get('/api/admin/fraud-alerts', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const duplicateAccounts = await prisma.$queryRaw`
      SELECT "bankAccount", COUNT(*) as count 
      FROM workers 
      WHERE "bankAccount" IS NOT NULL 
      GROUP BY "bankAccount" 
      HAVING COUNT(*) > 1
    `;

    const largePayouts = await prisma.payment.findMany({
      where: {
        type: 'PAYOUT',
        amount: { gt: 5000.0 }
      },
      include: { worker: true }
    });

    const rapidReplacements = await prisma.replacement.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) }
      },
      include: { household: true }
    });

    res.json({
      success: true,
      data: {
        duplicateBankAccountsCount: duplicateAccounts.length,
        largePayouts,
        rapidReplacementsCount: rapidReplacements.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

app.use((err, req, res, next) => {
  console.error('[UNHANDLED EXCEPTION]', err.stack);
  
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid JSON payload format.'
      }
    });
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An internal error occurred. Please contact support if the issue persists.'
    }
  });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[SERVER] TrustHouse server running on port ${PORT}`);
});
