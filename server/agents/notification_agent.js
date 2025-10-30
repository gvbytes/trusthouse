import dotenv from 'dotenv';
import { logSystemEvent } from '../db.js';

dotenv.config();

const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;

const templates = {
  en: {
    otp: "Your TrustHouse login verification OTP is: {otp}. Valid for 5 minutes.",
    checkin: "Check-in successful! Thank you for starting your shift at {time}.",
    checkout: "Check-out successful at {time}. Have a great rest of the day!",
    absence: "Your household worker is absent today. We are searching for an on-call replacement worker.",
    replacement: "Replacement confirmed! {name} (Rating: {rating}) will arrive within 1-4 hours.",
    kyc_complete: "KYC verification successful. Your digital ID card is active.",
    kyc_failed: "KYC verification failed. Please contact support to upload valid documents.",
    payout_sent: "Payout of INR {amount} has been successfully sent to your bank account."
  },
  hi: {
    otp: "आपका ट्रस्टहाउस लॉगिन सत्यापन ओटीपी है: {otp}। 5 मिनट के लिए वैध।",
    checkin: "चेक-इन सफल रहा! {time} पर काम शुरू करने के लिए धन्यवाद।",
    checkout: "चेक-आउट {time} पर सफल रहा। आपका दिन शुभ हो!",
    absence: "आपके सहायक आज अनुपस्थित हैं। हम वैकल्पिक सहायक की तलाश कर रहे हैं।",
    replacement: "वैकल्पिक सहायक की पुष्टि हो गई है! {name} (रेटिंग: {rating}) 1-4 घंटे में पहुंच जाएंगे।",
    kyc_complete: "KYC सत्यापन सफल रहा। आपका डिजिटल आईडी कार्ड सक्रिय है।",
    kyc_failed: "KYC सत्यापन विफल रहा। कृपया वैध दस्तावेज अपलोड करने के लिए सहायता टीम से संपर्क करें।",
    payout_sent: "INR {amount} का भुगतान आपके बैंक खाते में सफलतापूर्वक भेज दिया गया है।"
  }
};

/**
 * Audit log helper
 */
async function auditLog(type, message) {
  await logSystemEvent(type, message);
}

/**
 * Sends SMS / WhatsApp alerts.
 * Fallback to standard console logger if no API keys or mock number used.
 * @param {string} phone Destination phone number
 * @param {string} templateKey Key of message templates
 * @param {object} variables Mapping variables to replace in template
 * @param {string} lang Language code ('en' or 'hi')
 */
export async function sendNotification(phone, templateKey, variables = {}, lang = 'en') {
  const language = templates[lang] ? lang : 'en';
  let messageText = templates[language][templateKey] || '';

  if (!messageText) {
    throw new Error(`Notification template key "${templateKey}" not found.`);
  }

  // Replace variable placeholders
  for (const [key, val] of Object.entries(variables)) {
    messageText = messageText.replace(new RegExp(`{${key}}`, 'g'), val);
  }

  // Log locally for audit/debug trail
  console.log(`[NOTIFICATION] Sending ${language.toUpperCase()} SMS to ${phone}: "${messageText}"`);

  // Mock numbers starting with 99999 bypass real SMS calls
  if (!FAST2SMS_API_KEY || FAST2SMS_API_KEY.includes('FAST2SMS_API_KEY') || phone.startsWith('99999')) {
    const mockNote = `[MOCK SMS] Sent to ${phone}: ${messageText}`;
    await auditLog('NOTIFICATION_MOCK', mockNote);
    return { success: true, mode: 'mock', message: messageText };
  }

  try {
    // Call Fast2SMS bulkV2 route for transaction/quick messages
    const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        'authorization': FAST2SMS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        route: 'q',
        message: messageText,
        language: language === 'hi' ? 'hindi' : 'english',
        numbers: phone
      })
    });

    const data = await response.json();
    if (!response.ok || !data.return) {
      throw new Error(data.message || 'Fast2SMS returned error status');
    }

    await auditLog('NOTIFICATION_SENT', `SMS successfully sent to ${phone}`);
    return { success: true, mode: 'live', data };
  } catch (error) {
    console.error('[NOTIFICATION ERROR] Fast2SMS dispatch failed:', error.message);
    await auditLog('NOTIFICATION_FAILED', `SMS dispatch failed to ${phone}: ${error.message}`);
    // Return mock success so the user interaction/flow doesn't break in local dev environment
    return { success: false, mode: 'fallback_mock', error: error.message };
  }
}
