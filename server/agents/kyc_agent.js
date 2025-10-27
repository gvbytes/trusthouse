import crypto from 'crypto';
import dotenv from 'dotenv';
import { prisma, logSystemEvent } from '../db.js';
import { sendNotification } from './notification_agent.js';

dotenv.config();

const PERSONA_API_KEY = process.env.PERSONA_API_KEY;
const PERSONA_TEMPLATE_ID = process.env.PERSONA_TEMPLATE_ID;
const PERSONA_WEBHOOK_SECRET = process.env.PERSONA_WEBHOOK_SECRET;


export async function createPersonaInquiry(workerId, name) {
  console.log(`[KYC AGENT] Creating Persona Inquiry for worker ${workerId} (${name})`);

  if (!PERSONA_API_KEY || PERSONA_API_KEY.includes('mock') || PERSONA_API_KEY.includes('YOUR_')) {
    const mockInquiryId = `inq_${crypto.randomBytes(8).toString('hex')}`;
    const mockSessionUrl = `https://withpersona.com/verify?inquiry-id=${mockInquiryId}&template-id=${PERSONA_TEMPLATE_ID}`;
    
    await prisma.worker.update({
      where: { id: workerId },
      data: {
        kycStatus: 'PENDING',
        personaInquiryId: mockInquiryId
      }
    });

    return { inquiryId: mockInquiryId, sessionUrl: mockSessionUrl, mode: 'mock' };
  }

  try {
    const response = await fetch('https://withpersona.com/api/v1/inquiries', {
      method: 'POST',
      headers: {
        'Authorization': `Token token=${PERSONA_API_KEY}`,
        'Persona-Version': '2023-01-05',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          type: 'inquiry',
          attributes: {
            'template-id': PERSONA_TEMPLATE_ID,
            'reference-id': workerId,
            'subject': {
              'name-first': name
            }
          }
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.errors?.[0]?.title || 'Persona Inquiry creation failed');
    }

    const inquiryId = data.data.id;
    const sessionUrl = data.data.attributes['hosted-url'] || `https://withpersona.com/verify?inquiry-id=${inquiryId}`;

    await prisma.worker.update({
      where: { id: workerId },
      data: {
        kycStatus: 'PENDING',
        personaInquiryId: inquiryId
      }
    });

    return { inquiryId, sessionUrl, mode: 'live' };
  } catch (error) {
    console.error('[KYC AGENT ERROR] Failed to create inquiry:', error.message);
    throw error;
  }
}


export function verifyPersonaSignature(signatureHeader, rawBody) {
  if (!signatureHeader || !rawBody || !PERSONA_WEBHOOK_SECRET) {
    return false;
  }

  try {
    const parts = signatureHeader.split(',');
    const tPart = parts.find(p => p.startsWith('t='));
    const v1Part = parts.find(p => p.startsWith('v1='));

    if (!tPart || !v1Part) return false;

    const t = tPart.substring(2);
    const signature = v1Part.substring(3);

    const payload = `${t}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', PERSONA_WEBHOOK_SECRET);
    const computed = hmac.update(payload).digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(computed, 'hex')
    );
  } catch (e) {
    console.error('[KYC AGENT] Webhook signature verification error:', e.message);
    return false;
  }
}


export async function processPersonaWebhook(eventPayload) {
  const event = eventPayload.data;
  const eventType = eventPayload.data.type;
  const inquiryId = event.id;
  const status = event.attributes.status;
  const workerId = event.attributes['reference-id'];

  console.log(`[KYC AGENT Webhook] Received ${eventType} for inquiry ${inquiryId}. Status: ${status}`);

  const worker = await prisma.worker.findUnique({
    where: { id: workerId },
    include: { user: true }
  });
  
  if (!worker) {
    console.error(`[KYC AGENT] Worker not found for ID: ${workerId}`);
    return;
  }

  const phone = worker.user.phone;

  if (status === 'approved') {
    await prisma.worker.update({
      where: { id: workerId },
      data: { kycStatus: 'VERIFIED' }
    });
    
    await logSystemEvent(
      'KYC_APPROVED',
      `Worker ${workerId} successfully verified via Persona. Inquiry: ${inquiryId}`
    );

    await sendNotification(phone, 'kyc_complete', {}, 'en');
  } else if (status === 'declined' || status === 'failed') {
    await prisma.worker.update({
      where: { id: workerId },
      data: { kycStatus: 'FAILED' }
    });

    await logSystemEvent(
      'KYC_FAILED',
      `Worker ${workerId} failed KYC verification. Inquiry: ${inquiryId}`
    );

    await sendNotification(phone, 'kyc_failed', {}, 'en');
  } else if (status === 'needs_review') {
    await prisma.worker.update({
      where: { id: workerId },
      data: { kycStatus: 'NEEDS_REVIEW' }
    });

    await logSystemEvent(
      'KYC_NEEDS_REVIEW',
      `Worker ${workerId} KYC requires manual administrator check. Inquiry: ${inquiryId}`
    );
  }
}
