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

// Test connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('[DATABASE] PostgreSQL Connection failed:', err.message);
  } else {
    console.log('[DATABASE] PostgreSQL Pool connected successfully.');
  }
});

/**
 * Translates SQLite placeholder syntax (?) and SQLite-specific conflict keywords
 * to PostgreSQL standards ($1, $2, etc., and ON CONFLICT clauses) dynamically
 * while preserving the original parameter counts.
 */
export function translateQuery(sql) {
  let translated = sql;

  // 1. Translate SQLite conflict keywords to PostgreSQL conflicts
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

  // 2. Convert SQLite `?` to PostgreSQL `$1`, `$2`...
  let index = 1;
  translated = translated.replace(/\?/g, () => `$${index++}`);

  return translated;
}

/**
 * Promisified wrapper for pg pool.query. Use for INSERT, UPDATE, DELETE.
 */
export async function dbRun(sql, params = []) {
  const pgSql = translateQuery(sql);
  const res = await pool.query(pgSql, params);
  return { id: null, changes: res.rowCount };
}

/**
 * Promisified wrapper for pg pool.query. Use for SELECT returning a single row.
 */
export async function dbGet(sql, params = []) {
  const pgSql = translateQuery(sql);
  const res = await pool.query(pgSql, params);
  return res.rows[0] || null;
}

/**
 * Promisified wrapper for pg pool.query. Use for SELECT returning multiple rows.
 */
export async function dbAll(sql, params = []) {
  const pgSql = translateQuery(sql);
  const res = await pool.query(pgSql, params);
  return res.rows;
}

/**
 * Legacy db init, now a no-op as migrations handle DDL
 */
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
