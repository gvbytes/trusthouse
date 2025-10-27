import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[DATABASE] DATABASE_URL is missing from environment variables.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('[DATABASE] PostgreSQL Connection failed:', err.message);
  } else {
    console.log('[DATABASE] PostgreSQL Pool connected successfully.');
  }
});


export function translateQuery(sql) {
  let translated = sql;

  if (translated.includes('INSERT OR REPLACE INTO otp_sessions')) {
    translated = translated.replace('INSERT OR REPLACE INTO', 'INSERT INTO') + `
      ON CONFLICT (phone) DO UPDATE SET
        hashed_otp = EXCLUDED.hashed_otp,
        expires_at = EXCLUDED.expires_at,
        send_count = EXCLUDED.send_count,
        attempt_count = EXCLUDED.attempt_count,
        window_start = EXCLUDED.window_start
    `;
  } else if (translated.includes('INSERT OR REPLACE INTO attendances')) {
    translated = translated.replace('INSERT OR REPLACE INTO', 'INSERT INTO') + `
      ON CONFLICT (id) DO UPDATE SET
        booking_id = EXCLUDED.booking_id,
        worker_id = EXCLUDED.worker_id,
        date = EXCLUDED.date,
        checked_in = COALESCE(EXCLUDED.checked_in, attendances.checked_in),
        checked_out = COALESCE(EXCLUDED.checked_out, attendances.checked_out),
        status = EXCLUDED.status
    `;
  }

  if (translated.includes('INSERT OR IGNORE INTO')) {
    translated = translated.replace('INSERT OR IGNORE INTO', 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  }

  let index = 1;
  translated = translated.replace(/\?/g, () => `$${index++}`);

  return translated;
}


export async function dbRun(sql, params = []) {
  const pgSql = translateQuery(sql);
  const res = await pool.query(pgSql, params);
  return { id: null, changes: res.rowCount };
}


export async function dbGet(sql, params = []) {
  const pgSql = translateQuery(sql);
  const res = await pool.query(pgSql, params);
  return res.rows[0] || null;
}


export async function dbAll(sql, params = []) {
  const pgSql = translateQuery(sql);
  const res = await pool.query(pgSql, params);
  return res.rows;
}


export async function initDb() {
  console.log('[DATABASE] initDb called: using Prisma migrations for schema mapping.');
}

export async function logSystemEvent(action, details, userId = null) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        resource: 'system',
        details,
        userId
      }
    });
  } catch (err) {
    console.error('[DATABASE LOG ERROR] Failed to record system event:', err.message);
  }
}
