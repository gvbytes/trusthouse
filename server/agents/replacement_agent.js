import { prisma, logSystemEvent } from '../db.js';
import { sendNotification } from './notification_agent.js';
import redis from '../config/redis.js';
import crypto from 'crypto';

/**
 * Calculates Haversine distance in km between two lat/lng coordinates.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Triggers replacement process for an absent worker on a booking.
 * Walks through candidate workers in order of proximity, skill match, and ratings.
 * @param {string} bookingId ID of the affected booking (Assignment ID)
 * @param {string} absentWorkerId ID of the worker who is absent
 */
export async function triggerReplacementEngine(bookingId, absentWorkerId) {
  console.log(`[REPLACEMENT ENGINE] Triggered for booking ${bookingId}. Absent worker: ${absentWorkerId}`);

  // 1. Fetch booking (Assignment) details
  const booking = await prisma.assignment.findUnique({
    where: { id: bookingId }
  });
  if (!booking) {
    console.error(`[REPLACEMENT ENGINE] Booking ${bookingId} not found.`);
    return;
  }

  // 2. Fetch household info
  const household = await prisma.household.findUnique({
    where: { id: booking.householdId },
    include: { user: true }
  });
  if (!household) {
    console.error(`[REPLACEMENT ENGINE] Household not found for booking ${bookingId}.`);
    return;
  }

  // 3. Fetch absent worker's details (to match skills)
  const absentWorker = await prisma.worker.findUnique({
    where: { id: absentWorkerId }
  });
  if (!absentWorker) {
    console.error(`[REPLACEMENT ENGINE] Absent worker ${absentWorkerId} not found.`);
    return;
  }

  const requiredSkill = absentWorker.skills && absentWorker.skills.length > 0 ? absentWorker.skills[0] : '';

  // 4. Query all on-call, verified workers (excluding the absent one)
  const candidates = await prisma.worker.findMany({
    where: {
      id: { not: absentWorkerId },
      onCall: true,
      kycStatus: 'VERIFIED'
    },
    include: { user: true }
  });

  // 5. Score and filter candidates based on distance and skills
  const scoredCandidates = candidates
    .map(c => {
      const distance = calculateDistance(household.lat, household.lng, c.lat, c.lng);
      
      // Calculate skill score: does this candidate possess the exact skill?
      const hasSkill = c.skills && c.skills.includes(requiredSkill) ? 1 : 0;
      
      // Combined match score (prioritize exact skill, then close distance, then high rating)
      return {
        ...c,
        distance,
        hasSkill,
        score: hasSkill * 100 - distance + (c.rating * 2) + (c.trustScore * 0.1)
      };
    })
    // Limit to candidates within 20km radius
    .filter(c => c.distance <= 20)
    // Sort descending by score
    .sort((a, b) => b.score - a.score);

  console.log(`[REPLACEMENT ENGINE] Found ${scoredCandidates.length} eligible candidates within 20km.`);

  // 6. Sequence contact window simulation
  let replacementConfirmed = false;
  let confirmedCandidate = null;

  for (const candidate of scoredCandidates) {
    console.log(`[REPLACEMENT ENGINE] Offering booking to candidate ${candidate.name} (Distance: ${candidate.distance.toFixed(2)} km, Score: ${candidate.score.toFixed(2)})`);

    // Create a pending Replacement record in database
    const replacementId = `rep_${crypto.randomBytes(8).toString('hex')}`;
    const replacement = await prisma.replacement.create({
      data: {
        id: replacementId,
        assignmentId: bookingId,
        absentWorkerId: absentWorkerId,
        candidateWorkerId: candidate.id,
        householdId: household.id,
        status: 'PENDING'
      }
    });

    // Clear response state in Redis
    if (redis) {
      await redis.del(`replacement:response:${replacementId}`);
    }

    // Notify candidate of the offer
    await sendNotification(
      candidate.user.phone,
      'replacement',
      { name: household.name, rating: candidate.rating.toString() },
      'hi' // Default to Hindi for workers
    );

    // Wait up to 5 seconds (simulation mode) for candidate response via webhook
    let responseText = null;
    if (redis) {
      console.log(`[REPLACEMENT ENGINE] Waiting up to 5 seconds for candidate response on ${replacementId}...`);
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        responseText = await redis.get(`replacement:response:${replacementId}`);
        if (responseText) break;
      }
    }

    if (responseText === 'YES') {
      replacementConfirmed = true;
      confirmedCandidate = candidate;
      
      await prisma.replacement.update({
        where: { id: replacementId },
        data: {
          status: 'CONFIRMED',
          responseTime: new Date()
        }
      });
      break;
    } else {
      // Auto-decline or reject after timeout
      await prisma.replacement.update({
        where: { id: replacementId },
        data: {
          status: responseText === 'NO' ? 'REJECTED' : 'EXHAUSTED',
          responseTime: new Date()
        }
      });
      console.log(`[REPLACEMENT ENGINE] Candidate ${candidate.name} rejected or timed out. Trying next candidate.`);
    }
  }

  // 7. Handle confirmation or escalation
  if (replacementConfirmed && confirmedCandidate) {
    // Update booking (Assignment) to assign new worker
    await prisma.assignment.update({
      where: { id: bookingId },
      data: { workerId: confirmedCandidate.id }
    });
    
    // Log replacement success
    await logSystemEvent(
      'REPLACEMENT_SUCCESS',
      `Booking ${bookingId}: replaced worker ${absentWorkerId} with ${confirmedCandidate.id}`
    );

    // Notify household of success
    await sendNotification(
      household.user.phone,
      'replacement',
      { name: confirmedCandidate.name, rating: confirmedCandidate.rating.toFixed(1) },
      'en'
    );
  } else {
    // Total failure: Escalate to human admin
    await escalateToHumanAlert(bookingId, absentWorkerId, household);
  }
}

/**
 * Handles emergency escalation when no replacement is found.
 */
async function escalateToHumanAlert(bookingId, absentWorkerId, household) {
  const alertMsg = `EMERGENCY ALERT: No replacement found for booking ${bookingId}. Household: ${household.name} (${household.user.phone}). Absent worker: ${absentWorkerId}.`;
  console.error(`[REPLACEMENT ENGINE] ${alertMsg}`);

  // Log in system database
  await logSystemEvent('REPLACEMENT_ESCALATION', alertMsg);

  // Send critical SMS notification to Admin Support Line
  const adminPhone = '9999912345'; // Hardcoded mock support line
  await sendNotification(
    adminPhone,
    'absence',
    {},
    'en'
  );

  // Notify household that support is handling it manually
  await sendNotification(
    household.user.phone,
    'absence',
    {},
    'en'
  );
}
