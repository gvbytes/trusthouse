import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits tag

/**
 * Encrypts cleartext using AES-256-GCM.
 * @param {string} text Cleartext to encrypt
 * @returns {string|null} Encrypted string in format iv:tag:ciphertext
 */
export function encrypt(text) {
  if (!text) return null;
  
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }

  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts text encrypted using AES-256-GCM.
 * @param {string} encryptedText Encrypted data in format iv:tag:ciphertext
 * @returns {string|null} Decrypted cleartext or null if verification/decryption fails
 */
export function decrypt(encryptedText) {
  if (!encryptedText) return null;

  try {
    if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
    }

    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      return null;
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    // Audit log failure but never crash the system
    console.error('[SECURITY] Cryptographic failure during decryption:', error.message);
    return null;
  }
}
