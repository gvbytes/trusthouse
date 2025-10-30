import pkg from '@prisma/client';
const { PrismaClient, Role, KycStatus, Skill, WorkerPlan, HouseholdPlan, AssignmentStatus, AttendanceStatus, PaymentType, PaymentStatus, RatingType, PoliceVerificationStatus } = pkg;
import crypto from 'crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 12;

function encrypt(text) {
  if (!text) return null;
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

const pool = new pg.Pool({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('[SEED] Starting database seeding...');

  // Clean existing data in order of dependency
  await prisma.otpSession.deleteMany();
  await prisma.metricsSnapshot.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.rating.deleteMany();
  await prisma.replacement.deleteMany();
  await prisma.attendance.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.assignment.deleteMany();
  await prisma.worker.deleteMany();
  await prisma.household.deleteMany();
  await prisma.user.deleteMany();

  console.log('[SEED] Existing database tables cleared.');

  // Create Users & Workers
  const workersData = [
    // Rewa
    { name: 'Sunita Devi', phone: '9999922222', skills: [Skill.COOK, Skill.CLEANER], lat: 24.5241, lng: 81.3061, aadhaar: '123456781111', pan: 'ABCDE1234F', bank: '12345678901' },
    { name: 'Ramesh Kumar', phone: '9999933333', skills: [Skill.CLEANER], lat: 24.5300, lng: 81.3120, aadhaar: '123456782222', pan: 'ABCDE1234G', bank: '12345678902' },
    { name: 'Kiran Patel', phone: '9999944444', skills: [Skill.COOK, Skill.BABYSITTER], lat: 24.5150, lng: 81.2950, aadhaar: '123456783333', pan: 'ABCDE1234H', bank: '12345678903' },
    // Greater Noida
    { name: 'Amit Singh', phone: '9999922223', skills: [Skill.CARETAKER], lat: 28.4744, lng: 77.5040, aadhaar: '123456784444', pan: 'ABCDE1234I', bank: '12345678904' },
    { name: 'Pooja Sharma', phone: '9999922224', skills: [Skill.COOK, Skill.CLEANER], lat: 28.4680, lng: 77.4950, aadhaar: '123456785555', pan: 'ABCDE1234J', bank: '12345678905' },
    { name: 'Rajesh Yadav', phone: '9999922225', skills: [Skill.CLEANER, Skill.CARETAKER], lat: 28.4850, lng: 77.5120, aadhaar: '123456786666', pan: 'ABCDE1234K', bank: '12345678906' },
    { name: 'Babita Verma', phone: '9999922226', skills: [Skill.BABYSITTER], lat: 28.4600, lng: 77.4800, aadhaar: '123456787777', pan: 'ABCDE1234L', bank: '12345678907' },
    // Chennai
    { name: 'Lakshmi R.', phone: '9999922227', skills: [Skill.COOK, Skill.BABYSITTER], lat: 13.0827, lng: 80.2707, aadhaar: '123456788888', pan: 'ABCDE1234M', bank: '12345678908' },
    { name: 'Murugan K.', phone: '9999922228', skills: [Skill.CARETAKER, Skill.CLEANER], lat: 13.0750, lng: 80.2600, aadhaar: '123456789999', pan: 'ABCDE1234N', bank: '12345678909' },
    { name: 'Saraswathi M.', phone: '9999922229', skills: [Skill.COOK, Skill.CLEANER], lat: 13.0900, lng: 80.2850, aadhaar: '123456780000', pan: 'ABCDE1234O', bank: '12345678910' }
  ];

  const seededWorkers = [];
  for (const w of workersData) {
    const user = await prisma.user.create({
      data: {
        phone: w.phone,
        role: Role.WORKER
      }
    });

    const worker = await prisma.worker.create({
      data: {
        userId: user.id,
        name: w.name,
        skills: w.skills,
        lat: w.lat,
        lng: w.lng,
        rating: 4.5 + Math.random() * 0.5,
        trustScore: 60.0 + Math.random() * 20.0,
        kycStatus: KycStatus.VERIFIED,
        personaInquiryId: `inq_${crypto.randomBytes(8).toString('hex')}`,
        aadhaarLast4: encrypt(w.aadhaar),
        panNumber: encrypt(w.pan),
        bankAccount: encrypt(w.bank),
        onCall: true,
        plan: WorkerPlan.BASIC,
        policeVerificationStatus: PoliceVerificationStatus.VERIFIED
      }
    });
    seededWorkers.push(worker);
  }
  console.log(`[SEED] Created ${seededWorkers.length} workers.`);

  // Create Users & Households
  const householdsData = [
    { name: 'Rohan Sharma', phone: '9999911111', email: 'rohan@example.com', lat: 24.5250, lng: 81.3070, plan: HouseholdPlan.BASIC },
    { name: 'Vikram Singh', phone: '9999911112', email: 'vikram@example.com', lat: 24.5290, lng: 81.3100, plan: HouseholdPlan.PLUS },
    { name: 'Nikhil Gupta', phone: '9999911113', email: 'nikhil@example.com', lat: 28.4730, lng: 77.5010, plan: HouseholdPlan.PLUS },
    { name: 'Meera Nair', phone: '9999911114', email: 'meera@example.com', lat: 28.4650, lng: 77.4900, plan: HouseholdPlan.BASIC },
    { name: 'Anand Krishnan', phone: '9999911115', email: 'anand@example.com', lat: 13.0810, lng: 80.2680, plan: HouseholdPlan.PLUS }
  ];

  const seededHouseholds = [];
  for (const h of householdsData) {
    const user = await prisma.user.create({
      data: {
        phone: h.phone,
        email: h.email,
        role: Role.HOUSEHOLD
      }
    });

    const household = await prisma.household.create({
      data: {
        userId: user.id,
        name: h.name,
        plan: h.plan,
        lat: h.lat,
        lng: h.lng,
        trustScore: 70.0 + Math.random() * 20.0
      }
    });
    seededHouseholds.push(household);
  }
  console.log(`[SEED] Created ${seededHouseholds.length} households.`);

  // Seed Admin user
  const adminUser = await prisma.user.create({
    data: {
      phone: '9999900000',
      email: 'admin@trusthouse.in',
      role: Role.ADMIN
    }
  });
  console.log('[SEED] Created Admin account.');

  // Create 3 active assignments
  // 1. Sunita Devi (Worker[0]) -> Rohan Sharma (Household[0]) in Rewa
  // 2. Pooja Sharma (Worker[4]) -> Nikhil Gupta (Household[2]) in Greater Noida
  // 3. Lakshmi R. (Worker[7]) -> Anand Krishnan (Household[4]) in Chennai
  const assignmentsData = [
    { worker: seededWorkers[0], household: seededHouseholds[0], skill: Skill.COOK },
    { worker: seededWorkers[4], household: seededHouseholds[2], skill: Skill.COOK },
    { worker: seededWorkers[7], household: seededHouseholds[4], skill: Skill.COOK }
  ];

  const seededAssignments = [];
  for (const a of assignmentsData) {
    const assignment = await prisma.assignment.create({
      data: {
        householdId: a.household.id,
        workerId: a.worker.id,
        status: AssignmentStatus.ACTIVE,
        hourlyRate: a.worker.hourlyRate,
        commissionWorkerRate: 1.5,
        commissionHouseholdRate: 1.4,
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
      }
    });
    seededAssignments.push(assignment);
  }
  console.log(`[SEED] Created ${seededAssignments.length} active assignments.`);

  // Create 30 days of attendance, payments, and ratings
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const currentDate = new Date();
    currentDate.setDate(today.getDate() - i);
    const dateOnly = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());

    for (const assignment of seededAssignments) {
      // 90% chance present, 5% absent, 5% pending/skipped
      const rand = Math.random();
      let status = AttendanceStatus.PRESENT;
      let checkedIn = null;
      let checkedOut = null;

      if (rand < 0.05) {
        status = AttendanceStatus.ABSENT;
      } else if (rand < 0.1) {
        status = AttendanceStatus.PENDING;
      } else {
        // Present
        checkedIn = new Date(dateOnly.getTime());
        checkedIn.setHours(8, 0, 0, 0); // 8:00 AM
        checkedOut = new Date(dateOnly.getTime());
        checkedOut.setHours(16, 0, 0, 0); // 4:00 PM
      }

      const attendance = await prisma.attendance.create({
        data: {
          assignmentId: assignment.id,
          workerId: assignment.workerId,
          date: dateOnly,
          checkedIn,
          checkedOut,
          status
        }
      });

      // If present, create a wage payment and platform payout log
      if (status === AttendanceStatus.PRESENT) {
        const baseAmount = assignment.hourlyRate * 8; // Standard 8 hours
        const commissionWorker = baseAmount * (assignment.commissionWorkerRate / 100);
        const gst = commissionWorker * 0.18; // 18% GST on platform commission
        const finalPayout = baseAmount - (commissionWorker + gst);

        // Daily Payout record
        await prisma.payment.create({
          data: {
            workerId: assignment.workerId,
            amount: finalPayout,
            commission: commissionWorker,
            gst,
            type: PaymentType.PAYOUT,
            status: PaymentStatus.SUCCESS,
            razorpayPayoutId: `pout_${crypto.randomBytes(8).toString('hex')}`,
            invoiceUrl: `/invoices/INV-${dateOnly.toISOString().split('T')[0]}-${assignment.workerId.substring(0, 4)}.pdf`,
            createdAt: checkedOut
          }
        });

        // Daily Household Charge payment record
        const householdCharge = baseAmount + (baseAmount * (assignment.commissionHouseholdRate / 100));
        await prisma.payment.create({
          data: {
            householdId: assignment.householdId,
            amount: householdCharge,
            type: PaymentType.WAGE,
            status: PaymentStatus.SUCCESS,
            razorpayPaymentId: `pay_${crypto.randomBytes(8).toString('hex')}`,
            createdAt: checkedIn
          }
        });
      }
    }
  }
  console.log('[SEED] 30 days of attendance logs and financial records generated.');

  // Create ratings for assignments
  for (const assignment of seededAssignments) {
    // Household to Worker Rating
    await prisma.rating.create({
      data: {
        assignmentId: assignment.id,
        type: RatingType.HOUSEHOLD_TO_WORKER,
        score: 4.8,
        review: 'Very punctual and prepares delicious meals. Highly satisfied!',
        toWorkerId: assignment.workerId,
        fromHouseholdId: assignment.householdId
      }
    });

    // Worker to Household Rating
    await prisma.rating.create({
      data: {
        assignmentId: assignment.id,
        type: RatingType.WORKER_TO_HOUSEHOLD,
        score: 5.0,
        review: 'Polite household and pays on time.',
        toHouseholdId: assignment.householdId,
        fromWorkerId: assignment.workerId
      }
    });
  }
  console.log('[SEED] Mutual user trust ratings seeded.');

  // Create mock snapshots
  await prisma.metricsSnapshot.create({
    data: {
      totalWorkers: seededWorkers.length,
      totalHouseholds: seededHouseholds.length,
      activeAssignments: seededAssignments.length,
      totalRevenue: 25000.0,
      totalPayouts: 23500.0,
      replacementSuccessRate: 100.0
    }
  });
  console.log('[SEED] Metrics snapshot recorded.');

  console.log('[SEED] Seeding successfully completed!');
}

main()
  .catch((e) => {
    console.error('[SEED ERROR] Seeding aborted due to exception:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
