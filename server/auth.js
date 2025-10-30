import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { prisma } from './db.js';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const OTP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

if (!JWT_SECRET) {
  console.error('[SECURITY] JWT_SECRET is not configured in environment variables.');
}

/**
 * SHA-256 string hashing.
 */
export function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Generates a 6-digit numeric OTP.
 */
export function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Initiates an OTP session for a phone number with strict rate limiting.
 * Rate limit check: max 3 requests per 15-minute window.
 */
export async function requestOTP(phone) {
  const now = new Date();
  const otpWindowStartLimit = new Date(now.getTime() - OTP_WINDOW_MS);

  let session = await prisma.otpSession.findUnique({
    where: { phone }
  });

  if (session) {
    // If the 15-minute window has elapsed, reset the window counters
    if (session.windowStart < otpWindowStartLimit) {
      session.sendCount = 1;
      session.attemptCount = 0;
      session.windowStart = now;
    } else {
      if (session.sendCount >= 3) {
        throw new Error('OTP limit reached. Please wait 15 minutes before trying again.');
      }
      session.sendCount += 1;
    }
  } else {
    session = {
      phone,
      sendCount: 1,
      attemptCount: 0,
      windowStart: now
    };
  }

  const rawOtp = generateOTP();
  const hashedOtp = hashString(rawOtp);
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);

  await prisma.otpSession.upsert({
    where: { phone },
    update: {
      hashedOtp,
      expiresAt,
      sendCount: session.sendCount,
      attemptCount: session.attemptCount,
      windowStart: session.windowStart
    },
    create: {
      phone,
      hashedOtp,
      expiresAt,
      sendCount: session.sendCount,
      attemptCount: session.attemptCount,
      windowStart: session.windowStart
    }
  });

  return rawOtp;
}

/**
 * Verifies an OTP with safety checks:
 * - Session must exist
 * - Must not be expired
 * - Max 5 incorrect attempts before invalidating the OTP
 */
export async function verifyOTP(phone, userOtp) {
  const now = new Date();
  const session = await prisma.otpSession.findUnique({
    where: { phone }
  });

  if (!session) {
    throw new Error('No authentication session found. Please request a new OTP.');
  }

  // Check if session has expired
  if (now > session.expiresAt) {
    await prisma.otpSession.delete({ where: { phone } }).catch(() => {});
    throw new Error('OTP has expired. Please request a new one.');
  }

  // Check attempt limit
  if (session.attemptCount >= 5) {
    await prisma.otpSession.delete({ where: { phone } }).catch(() => {});
    throw new Error('Too many incorrect attempts. This OTP has been invalidated.');
  }

  const hashedInput = hashString(userOtp);
  if (session.hashedOtp !== hashedInput) {
    await prisma.otpSession.update({
      where: { phone },
      data: { attemptCount: { increment: 1 } }
    });
    throw new Error('Incorrect OTP.');
  }

  // Correct verification - invalidate session
  await prisma.otpSession.delete({ where: { phone } }).catch(() => {});
  return true;
}

/**
 * Issues a JWT token signed with JWT_SECRET.
 */
export function generateToken(user) {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Deny-by-default token authentication middleware.
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Authenticating token missing.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired authentication token.' });
    }
    req.user = decoded;
    next();
  });
}

/**
 * Role authorization guard.
 * Checks user role against allowed list.
 */
export function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.map(r => r.toUpperCase()).includes(req.user.role.toUpperCase())) {
      return res.status(403).json({ error: 'Access forbidden. Insufficient permissions.' });
    }
    next();
  };
}
