import { z } from 'zod';


export function validate(schema) {
  return (req, res, next) => {
    try {
      schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issues = err.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request payload parameters.',
            details: issues
          }
        });
      }
      next(err);
    }
  };
}

export const otpRequestSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, 'Must be a valid 10-digit Indian phone number.')
});

export const otpVerifySchema = z.object({
  phone: z.string().regex(/^\d{10}$/, 'Must be a 10-digit phone number.'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 digits.'),
  role: z.enum(['worker', 'household']).optional(),
  name: z.string().min(2, 'Name must be at least 2 characters.').max(100).optional(),
  skills: z.string().optional(),
  lat: z.number().min(6.0).max(38.0).optional(),
  lng: z.number().min(68.0).max(98.0).optional()
});

export const firebaseLoginSchema = z.object({
  email: z.string().email('Must be a valid email address.'),
  name: z.string().min(2).max(100).optional(),
  role: z.enum(['household', 'admin']).default('household'),
  firebaseUid: z.string().min(1, 'Firebase UID is required.')
});

export const kycInitiateSchema = z.object({
  aadhaarNumber: z.string().regex(/^\d{12}$/, 'Aadhaar must be exactly 12 numerical digits.')
});

export const attendanceSchema = z.object({
  action: z.enum(['checkin', 'checkout', 'absent']),
  bookingId: z.string().uuid('Booking ID (Assignment ID) must be a valid UUID.'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in format YYYY-MM-DD.').optional()
});

export const bookingCreateSchema = z.object({
  workerId: z.string().uuid('Worker ID must be a valid UUID.')
});

export const ratingSubmitSchema = z.object({
  assignmentId: z.string().uuid('Assignment ID must be a valid UUID.'),
  type: z.enum(['worker_to_household', 'household_to_worker']),
  score: z.number().min(1.0).max(5.0),
  review: z.string().max(500).optional()
});

export const adminPayoutRunSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in format YYYY-MM-DD.').optional()
});

export const consentSchema = z.object({
  consented: z.boolean().refine(val => val === true, 'Consent must be explicitly granted.')
});

