import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const requiredBuckets = ['worker-id-cards', 'worker-kyc-docs', 'invoices'];

const isMockMode = 
  !SUPABASE_URL || 
  !SUPABASE_SERVICE_ROLE_KEY || 
  SUPABASE_SERVICE_ROLE_KEY.includes('placeholder') ||
  SUPABASE_SERVICE_ROLE_KEY === '';

let supabase = null;

if (!isMockMode) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false
      }
    });
  } catch (err) {
    console.error('[STORAGE] Initialization failed. Falling back to local MOCK storage.', err.message);
  }
}


export async function initStorage() {
  if (isMockMode || !supabase) {
    console.log('[STORAGE] Connection health check: MOCK MODE. local filesystem storage active.');
    
    const baseStoragePath = path.resolve(__dirname, '../../storage');
    for (const bucket of requiredBuckets) {
      const bucketPath = path.join(baseStoragePath, bucket);
      if (!fs.existsSync(bucketPath)) {
        fs.mkdirSync(bucketPath, { recursive: true });
      }
    }
    console.log(`[STORAGE] Local sandbox directories created successfully at: ${baseStoragePath}`);
    return;
  }

  try {
    console.log('[STORAGE] Initializing Supabase Storage buckets...');
    
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) throw listError;

    const existingNames = buckets.map((b) => b.name);

    for (const bucketName of requiredBuckets) {
      if (!existingNames.includes(bucketName)) {
        console.log(`[STORAGE] Creating private bucket: ${bucketName}...`);
        const { error: createError } = await supabase.storage.createBucket(bucketName, {
          public: false,
          fileSizeLimit: 10 * 1024 * 1024
        });
        if (createError) throw createError;
      }
    }

    console.log('[STORAGE] Connection health check: SUCCESS. Supabase Storage initialized and ready.');
  } catch (error) {
    console.error('[STORAGE] Critical Error during initialization:', error.message);
    console.log('[STORAGE] Falling back to local mock storage mode to ensure runtime continuity.');
    supabase = null;
  }
}


export async function uploadFile(bucketName, filePath, fileBuffer, contentType = 'application/octet-stream') {
  if (isMockMode || !supabase) {
    console.log(`[STORAGE MOCK] Uploading file to local storage: ${bucketName}/${filePath}`);
    const localDest = path.resolve(__dirname, '../../storage', bucketName, filePath);
    fs.mkdirSync(path.dirname(localDest), { recursive: true });
    fs.writeFileSync(localDest, fileBuffer);
    return { success: true, path: filePath, mode: 'mock' };
  }

  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(filePath, fileBuffer, {
        contentType,
        upsert: true
      });

    if (error) throw error;
    return { success: true, path: data.path, mode: 'live' };
  } catch (error) {
    console.error(`[STORAGE ERROR] Upload failed for ${bucketName}/${filePath}:`, error.message);
    throw error;
  }
}


export async function getSignedUrl(bucketName, filePath, expiresInSeconds = 900) {
  if (isMockMode || !supabase) {
    return `/api/mock-storage/${bucketName}/${filePath}?token=mock_signed_expiry_${Date.now() + expiresInSeconds * 1000}`;
  }

  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(filePath, expiresInSeconds);

    if (error) throw error;
    return data.signedUrl;
  } catch (error) {
    console.error(`[STORAGE ERROR] Failed to generate signed URL for ${bucketName}/${filePath}:`, error.message);
    throw error;
  }
}
