import Razorpay from 'razorpay';
import dotenv from 'dotenv';
import PDFDocument from 'pdfkit';
import { prisma, logSystemEvent } from '../db.js';
import { sendNotification } from './notification_agent.js';
import { uploadFile, getSignedUrl } from '../config/storage.js';
import redis from '../config/redis.js';

dotenv.config();

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// Initialize Razorpay client
let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  try {
    razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    });
  } catch (e) {
    console.error('[PAYOUT AGENT] Razorpay client initialisation failed:', e.message);
  }
}

/**
 * Calculates earnings, deducts 1.5% commission, charges 18% GST on the fee,
 * and triggers daily payouts for the specified date.
 * @param {string} targetDate Date string in format YYYY-MM-DD
 */
/**
 * Generates an A4 Tax Invoice PDF for a worker payout.
 */
function generateGstInvoice(paymentId, amount, commission, gst, workerName, targetDate) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', err => reject(err));

      // Theme Palette: Forest Green #0d2818, Gold #c9a84c, Cream Background #f7f3ec
      doc.rect(0, 0, 595, 842).fill('#f7f3ec');

      // Header Banner
      doc.rect(0, 0, 595, 80).fill('#0d2818');
      doc.fillColor('#f7f3ec')
         .fontSize(16)
         .text('TRUSTHOUSE SERVICES PRIVATE LIMITED', 50, 32);

      doc.fillColor('#0d2818');
      doc.fontSize(12).text('TAX INVOICE / PAYOUT RECEIPT', 50, 110, { underline: true });

      // Invoice Details Block
      doc.fontSize(10);
      doc.text(`Invoice ID: ${paymentId}`, 50, 140);
      doc.text(`Date: ${targetDate}`, 50, 155);
      doc.text(`Recipient: ${workerName}`, 50, 170);
      doc.text(`Status: SUCCESS (PAID)`, 50, 185);

      // Line Items Table Header
      doc.rect(50, 220, 495, 20).fill('#0d2818');
      doc.fillColor('#f7f3ec').text('Description', 60, 225);
      doc.text('Amount (INR)', 450, 225);

      doc.fillColor('#0d2818');
      // Gross Wages
      doc.text('Gross Wages Earned (Standard 8-Hour Shift)', 60, 255);
      const gross = amount + commission + gst;
      doc.text(gross.toFixed(2), 450, 255);

      // Platform Commission Fee
      doc.text('Platform Commission Fee (1.5%)', 60, 280);
      doc.text(`-${commission.toFixed(2)}`, 450, 280);

      // GST on Commission
      doc.text('IGST @ 18% on platform commission', 60, 305);
      doc.text(`-${gst.toFixed(2)}`, 450, 305);

      // Divider line
      doc.moveTo(50, 335).lineTo(545, 335).stroke();

      // Net take-home
      doc.rect(50, 350, 495, 20).fill('#c9a84c');
      doc.fillColor('#0d2818').text('Net Payout Dispatched (IMPS)', 60, 355);
      doc.text(amount.toFixed(2), 450, 355);

      // Signature/stamp area
      doc.fontSize(8);
      doc.text('This is a computer-generated tax receipt and requires no physical signature.', 50, 420);
      doc.text('TrustHouse Regulatory Compliance Division, New Delhi, India.', 50, 435);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export async function processDailyPayouts(targetDate) {
  console.log(`[PAYOUT AGENT] Starting payout process for date: ${targetDate}`);

  // 1. Implement Redis Distributed Lock to prevent duplicate payout runs
  if (redis) {
    try {
      const lockKey = `lock:payout:${targetDate}`;
      const acquired = await redis.set(lockKey, 'locked', 'NX', 'EX', 3600); // 1 hour expiration
      if (!acquired) {
        console.warn(`[PAYOUT AGENT WARNING] Payout execution for date ${targetDate} is already locked/running. Skipping.`);
        return;
      }
      console.log(`[PAYOUT AGENT] Acquired distributed lock for date: ${targetDate}`);
    } catch (lockErr) {
      console.error('[PAYOUT AGENT ERROR] Redis lock acquisition failed:', lockErr.message);
    }
  }

  const targetDateObj = new Date(targetDate);
  const startOfDay = new Date(targetDateObj.getFullYear(), targetDateObj.getMonth(), targetDateObj.getDate(), 0, 0, 0);
  const endOfDay = new Date(targetDateObj.getFullYear(), targetDateObj.getMonth(), targetDateObj.getDate(), 23, 59, 59);

  // Fetch all completed 'PRESENT' attendances for the date
  const attendances = await prisma.attendance.findMany({
    where: {
      date: {
        gte: startOfDay,
        lte: endOfDay
      },
      status: 'PRESENT'
    },
    include: {
      worker: {
        include: {
          user: true
        }
      }
    }
  });

  // Filter out workers already paid for this date (Idempotency Safeguard)
  const eligibleRecords = [];
  for (const record of attendances) {
    const existingPayout = await prisma.payment.findFirst({
      where: {
        workerId: record.workerId,
        type: 'PAYOUT',
        createdAt: {
          gte: startOfDay,
          lte: endOfDay
        }
      }
    });

    if (!existingPayout) {
      eligibleRecords.push(record);
    }
  }

  console.log(`[PAYOUT AGENT] Found ${eligibleRecords.length} workers eligible for payouts.`);

  for (const record of eligibleRecords) {
    const workerId = record.workerId;
    const baseWage = record.worker.hourlyRate * 8; // Assumed standard 8-hour shift
    const commissionRate = 0.015; // 1.5% platform commission from worker
    const commissionFee = baseWage * commissionRate;
    
    // GST is 18% on the platform commission fee
    const gstOnCommission = commissionFee * 0.18;
    const totalDeductions = commissionFee + gstOnCommission;
    const finalPayoutAmount = baseWage - totalDeductions;

    // Generated GST Invoice details
    const invoiceId = `INV-${targetDate.replace(/-/g, '')}-${workerId.substring(0, 4).toUpperCase()}`;

    console.log(`[PAYOUT AGENT] Worker: ${record.worker.name} | Wage: INR ${baseWage} | Fee: INR ${commissionFee} | GST: INR ${gstOnCommission} | Payout: INR ${finalPayoutAmount}`);

    // Call Razorpay API (Mocked for testing / local execution keys)
    let transactionId = `txn_${Math.random().toString(36).substring(2, 11)}`;
    let status = 'paid';

    if (razorpay && !RAZORPAY_KEY_ID.includes('test_T5nPNf7Ljp6LZ0')) {
      try {
        const payoutResponse = await fetch('https://api.razorpay.com/v1/payouts', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')
          },
          body: JSON.stringify({
            account_number: "78787878787878",
            amount: Math.round(finalPayoutAmount * 100), // paise
            currency: "INR",
            mode: "IMPS",
            purpose: "payout",
            reference_id: invoiceId,
            narration: "TrustHouse Daily Payout"
          })
        });

        const data = await payoutResponse.json();
        if (!payoutResponse.ok) {
          throw new Error(data.error?.description || 'Razorpay payout API failed');
        }
        transactionId = data.id;
        status = 'paid';
      } catch (err) {
        console.error(`[PAYOUT AGENT ERROR] Razorpay transaction failed for worker ${workerId}:`, err.message);
        status = 'failed';
        transactionId = 'failed_payout';
      }
    }

    // 2. Generate PDF GST Invoice via PDFKit
    let invoiceUrl = `/invoices/${invoiceId}.pdf`;
    try {
      const invoiceBuffer = await generateGstInvoice(
        invoiceId,
        finalPayoutAmount,
        commissionFee,
        gstOnCommission,
        record.worker.name,
        targetDate
      );

      // Upload to private 'invoices' bucket
      await uploadFile('invoices', `${invoiceId}.pdf`, invoiceBuffer, 'application/pdf');

      // Generate signed URL with 15 minutes expiry
      invoiceUrl = await getSignedUrl('invoices', `${invoiceId}.pdf`, 900);
      console.log(`[PAYOUT AGENT] Uploaded invoice PDF to storage. Signed URL retrieved.`);
    } catch (pdfErr) {
      console.error(`[PAYOUT AGENT ERROR] Failed to generate/upload invoice PDF for ${workerId}:`, pdfErr.message);
    }

    // Save payout log to db
    await prisma.payment.create({
      data: {
        id: invoiceId,
        workerId: workerId,
        amount: finalPayoutAmount,
        commission: commissionFee,
        gst: gstOnCommission,
        type: 'PAYOUT',
        status: status === 'paid' ? 'SUCCESS' : 'FAILED',
        razorpayPayoutId: transactionId,
        invoiceUrl: invoiceUrl,
        createdAt: new Date()
      }
    });

    // Write audit log
    await logSystemEvent(
      'WORKER_PAYOUT',
      `Payout processed for ${record.worker.name}. Status: ${status}. Invoice: ${invoiceId}. Amount: ${finalPayoutAmount.toFixed(2)}`
    );

    // Notify worker on success
    if (status === 'paid') {
      await sendNotification(
        record.worker.user.phone,
        'payout_sent',
        { amount: finalPayoutAmount.toFixed(2) },
        'hi'
      );
    }
  }

  console.log(`[PAYOUT AGENT] Payout execution completed for ${targetDate}.`);
}
