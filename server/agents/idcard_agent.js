import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { uploadFile, getSignedUrl } from '../config/storage.js';

/**
 * Generates a pocket-sized PDF ID Card for a verified worker.
 * Includes details, trust rating, and a verification QR code.
 * Uploads to Supabase Storage and returns a 15-minute signed URL.
 * @param {object} worker Worker database record
 * @returns {string} Signed storage access URL
 */
export async function generateWorkerIdCard(worker) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. Generate QR Code image as data URL linking to public verify route
      const verifyUrl = `https://trusthouse.in/verify/${worker.id}`;
      const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 200 });
      const qrBuffer = Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/, ""), 'base64');

      // 2. Create PDF Kit Document (Standard ID-1 card dimensions at 72 points/inch: 243 x 153 points)
      const doc = new PDFDocument({ size: [243, 153], margin: 10 });
      
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', async () => {
        const pdfBuffer = Buffer.concat(chunks);
        const fileName = `${worker.id}-idcard.pdf`;
        
        try {
          // Upload to private bucket worker-id-cards
          await uploadFile('worker-id-cards', fileName, pdfBuffer, 'application/pdf');
          
          // Generate 15 minutes signed URL
          const signedUrl = await getSignedUrl('worker-id-cards', fileName, 900);
          resolve(signedUrl);
        } catch (err) {
          reject(err);
        }
      });

      // 3. Draw Design Elements using palette: forest green #0d2818, warm cream #f7f3ec, gold #c9a84c
      // Background
      doc.rect(0, 0, 243, 153).fill('#f7f3ec');
      
      // Header Bar
      doc.rect(0, 0, 243, 25).fill('#0d2818');
      
      // Title
      doc.fillColor('#f7f3ec')
         .fontSize(8)
         .text('TRUSTHOUSE IDENTITY', 10, 8, { lineBreak: false });

      // Worker details
      doc.fillColor('#0d2818');
      doc.fontSize(9).text(worker.name, 10, 35, { width: 140 });
      
      const skillsText = worker.skills ? worker.skills.join(', ') : 'HOUSEHOLD HELPER';
      doc.fontSize(6)
         .text(`SKILLS: ${skillsText}`, 10, 52, { width: 135 })
         .text(`TRUST SCORE: ${worker.trustScore.toFixed(0)}`, 10, 72)
         .text(`RATING: ${worker.rating.toFixed(1)} / 5.0`, 10, 84)
         .text(`STATUS: VERIFIED`, 10, 96);

      // Draw active status badge decoration
      doc.rect(10, 110, 60, 12).fill('#0d2818');
      doc.fillColor('#c9a84c')
         .fontSize(5)
         .text('ACTIVE KYC', 22, 114);

      // Draw QR Code
      doc.image(qrBuffer, 150, 35, { width: 85, height: 85 });

      // Footer bar
      doc.rect(0, 138, 243, 15).fill('#c9a84c');
      doc.fillColor('#0d2818')
         .fontSize(5)
         .text('Scan QR to verify worker status on trusthouse.in', 10, 143);

      doc.end();
    } catch (error) {
      console.error('[ID CARD AGENT ERROR] PDF Generation failed:', error.message);
      reject(error);
    }
  });
}
