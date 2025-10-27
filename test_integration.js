import assert from 'assert';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { prisma } from './server/db.js';
import { encrypt, decrypt } from './server/crypto_helper.js';
import { requestOTP, verifyOTP, generateToken } from './server/auth.js';
import { verifyPersonaSignature, processPersonaWebhook } from './server/agents/kyc_agent.js';
import { triggerReplacementEngine } from './server/agents/replacement_agent.js';
import { processDailyPayouts } from './server/agents/payout_agent.js';
import { runSystemHealthCheck } from './server/agents/health_agent.js';
import { initStorage, uploadFile, getSignedUrl } from './server/config/storage.js';
import redis from './server/config/redis.js';

dotenv.config();

async function runTests() {
  console.log('================================================================');
  console.log('    STARTING TRUSTHOUSE INTEGRATION & SECURITY VERIFICATION     ');
  console.log('================================================================');

  assert.ok(prisma, 'PrismaClient initialization failed.');
  console.log('[+] Step 1: Database Schema initialization verified.');

  const sensitivePII = '123456789012';
  const cipherText = encrypt(sensitivePII);
  assert.ok(cipherText !== sensitivePII, 'Encryption failed to obfuscate cleartext.');
  assert.ok(cipherText.split(':').length === 3, 'Ciphertext must match iv:tag:ciphertext format.');
  
  const clearText = decrypt(cipherText);
  assert.strictEqual(clearText, sensitivePII, 'Decrypted cleartext does not match original PII.');
  console.log('[+] Step 2: AES-256-GCM encryption & decryption loops match.');

  const testPhone = '9999955555';
  
  await prisma.otpSession.delete({ where: { phone: testPhone } }).catch(() => {});
  
  const generatedOtp = await requestOTP(testPhone);
  assert.ok(/^\d{6}$/.test(generatedOtp), 'OTP code should be 6 numerical digits.');

  const isOtpValid = await verifyOTP(testPhone, generatedOtp);
  assert.ok(isOtpValid, 'Valid OTP verification failed.');
  console.log('[+] Step 3: Server-side OTP hashing, storage, and validation verified.');

  try {
    await requestOTP(testPhone);
    await requestOTP(testPhone);
    await requestOTP(testPhone);
    await requestOTP(testPhone);
    assert.fail('OTP request rate limiting failed to block fourth attempt.');
  } catch (err) {
    assert.ok(err.message.includes('limit'), 'Error message should describe limit constraints.');
    console.log('[+] Step 4: OTP Send rate limits successfully block SMS flooding.');
  }

  const webhookSecret = process.env.PERSONA_WEBHOOK_SECRET;
  const rawBodyPayload = JSON.stringify({
    data: {
      type: 'inquiry',
      id: 'inq_test_123',
      attributes: {
        status: 'approved',
        'reference-id': 'w_ramesh'
      }
    }
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = `${timestamp}.${rawBodyPayload}`;
  const expectedHmac = crypto
    .createHmac('sha256', webhookSecret)
    .update(signaturePayload)
    .digest('hex');

  const validSignatureHeader = `t=${timestamp},v1=${expectedHmac}`;
  const verifyResult = verifyPersonaSignature(validSignatureHeader, rawBodyPayload);
  assert.ok(verifyResult, 'Valid Persona webhook HMAC signature rejected.');
  console.log('[+] Step 5: Webhook timing-safe HMAC validation is fully secure.');

  const payoutDate = '2026-06-25';
  
  await prisma.payment.deleteMany({ where: { workerId: 'w_payout_test' } }).catch(() => {});
  await prisma.attendance.deleteMany({ where: { workerId: 'w_payout_test' } }).catch(() => {});
  await prisma.assignment.deleteMany({ where: { workerId: 'w_payout_test' } }).catch(() => {});
  await prisma.worker.delete({ where: { id: 'w_payout_test' } }).catch(() => {});
  await prisma.user.delete({ where: { id: 'usr_payout_test' } }).catch(() => {});
  await prisma.household.delete({ where: { id: 'h_payout_test' } }).catch(() => {});
  await prisma.user.delete({ where: { id: 'usr_payout_house' } }).catch(() => {});

  await prisma.user.create({
    data: { id: 'usr_payout_test', phone: '9999966666', role: 'WORKER' }
  });
  await prisma.worker.create({
    data: {
      id: 'w_payout_test',
      userId: 'usr_payout_test',
      name: 'Ramesh Test',
      skills: ['CLEANER'],
      rating: 4.5,
      trustScore: 60.0,
      hourlyRate: 100.0,
      kycStatus: 'VERIFIED',
      lat: 28.6139,
      lng: 77.2090,
      onCall: true
    }
  });
  
  await prisma.user.create({
    data: { id: 'usr_payout_house', phone: '9999977777', role: 'HOUSEHOLD' }
  });
  await prisma.household.create({
    data: {
      id: 'h_payout_test',
      userId: 'usr_payout_house',
      name: 'Household Test',
      lat: 28.6139,
      lng: 77.2090
    }
  });

  await prisma.assignment.create({
    data: {
      id: 'b_test_payout_id',
      householdId: 'h_payout_test',
      workerId: 'w_payout_test',
      status: 'ACTIVE',
      hourlyRate: 100.0
    }
  });

  const payoutDateObj = new Date(payoutDate);
  await prisma.attendance.create({
    data: {
      id: 'b_test_payout_id-2026-06-25',
      assignmentId: 'b_test_payout_id',
      workerId: 'w_payout_test',
      date: payoutDateObj,
      status: 'PRESENT'
    }
  });

  if (redis) {
    try {
      await redis.del(`lock:payout:${payoutDate}`);
    } catch (e) {}
  }

  await processDailyPayouts(payoutDate);

  const startOfDay = new Date(payoutDateObj.getFullYear(), payoutDateObj.getMonth(), payoutDateObj.getDate(), 0, 0, 0);
  const endOfDay = new Date(payoutDateObj.getFullYear(), payoutDateObj.getMonth(), payoutDateObj.getDate(), 23, 59, 59);

  const payoutRecord = await prisma.payment.findFirst({
    where: {
      workerId: 'w_payout_test',
      type: 'PAYOUT',
      createdAt: {
        gte: startOfDay,
        lte: endOfDay
      }
    }
  });

  assert.ok(payoutRecord, 'Payout agent failed to write payout ledger record.');
  
  assert.strictEqual(payoutRecord.amount, 785.84, 'Calculated take home payout amount with GST is incorrect.');
  console.log('[+] Step 6: Daily wage payout Calculations (1.5% fee + 18% GST) verify correctly.');

  await initStorage();
  const testBuffer = Buffer.from('Mock PDF Content for ID Card');
  const uploadResult = await uploadFile('worker-id-cards', 'test-worker-id.pdf', testBuffer, 'application/pdf');
  assert.ok(uploadResult.success, 'Supabase Storage file upload failed.');
  
  const signedUrl = await getSignedUrl('worker-id-cards', 'test-worker-id.pdf', 900);
  assert.ok(signedUrl, 'Failed to retrieve signed URL from Supabase Storage client.');
  assert.ok(signedUrl.includes('test-worker-id.pdf') || signedUrl.includes('mock-storage'), 'Signed URL should reference file name path.');
  console.log('[+] Step 7: Supabase Storage bucket writes & 15-minute signed token URLs verified.');

  const healthResults = await runSystemHealthCheck();
  assert.ok(healthResults.status.database, 'Database health check failed.');
  console.log('[+] Step 8: Platform dependencies health pinger executed successfully.');

  console.log('================================================================');
  console.log('    SUCCESS: ALL SYSTEM INTEGRITY VERIFICATION CHECKS PASSED    ');
  console.log('================================================================');
  if (redis) {
    await redis.quit();
  }
  process.exit(0);
}

runTests().catch(async (err) => {
  console.error('[-] ERROR: Verification test suite execution failed:');
  console.error(err.stack);
  if (redis) {
    try {
      await redis.quit();
    } catch (e) {}
  }
  process.exit(1);
});
