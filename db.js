// db.js
import { config } from "dotenv";
config({ path: ".env", override: true });

import crypto from "node:crypto";
import pg from "pg";
const { Pool } = pg;

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    // Ensure SSL on and keep using the Neon pooled URL
    const url = process.env.DATABASE_URL.includes("sslmode=")
      ? process.env.DATABASE_URL
      : `${process.env.DATABASE_URL}${
          process.env.DATABASE_URL.includes("?") ? "&" : "?"
        }sslmode=require`;

    pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      keepAlive: true,
    });
  }
  return pool;
}

export async function assertDb() {
  const p = getPool();
  const { rows } = await p.query("select now() as now");
  return rows[0].now;
}

export async function endPool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function insertEntry(e) {
  const p = getPool();
  const id = crypto.randomUUID(); // v4 UUID

  const sql = `
    INSERT INTO journal_entries (
      id, user_id, mood, summary, transcript, advice, audio_path,
      model_asr, model_analysis, ms_elapsed, project_id,
      tokens_input, tokens_output, duration_seconds, cost_estimate_usd
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      $8,$9,$10,$11,
      $12,$13,$14,$15
    )
    RETURNING *;
  `;

  const params = [
    id,
    e.user_id ?? null,
    e.mood ?? null,
    e.summary ?? null,
    e.transcript ?? null,
    e.advice ?? null,
    e.audio_path ?? null,
    e.model_asr ?? null, // e.g. "gpt-4o-mini-transcribe"
    e.model_analysis ?? null, // e.g. "gpt-4o-mini"
    e.ms_elapsed == null ? null : Number(e.ms_elapsed),
    e.project_id ?? null,
    e.tokens_input == null ? null : Number(e.tokens_input),
    e.tokens_output == null ? null : Number(e.tokens_output),
    e.duration_seconds == null ? null : Number(e.duration_seconds),
    e.cost_estimate_usd == null ? null : Number(e.cost_estimate_usd),
  ];

  const { rows } = await p.query(sql, params);
  return rows[0];
}

export async function listEntries(limit = 20) {
  const p = getPool();
  const { rows } = await p.query(
    `
    SELECT id, created_at, mood, summary, advice
    FROM journal_entries
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows;
}
export async function listEntriesByLimit(limit = 20) {
  const p = getPool();
  const { rows } = await p.query(
    `SELECT id, created_at, mood, summary, advice
     FROM journal_entries
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getDailyMood(days = 14, userId = null) {
  const p = getPool();
  const maxDays = Math.min(Math.max(Number(days) || 14, 1), 90); // clamp 1..90

  const whereUser = userId ? "AND e.user_id = $1" : "";
  const sql = `
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now()) - ($2::int - 1) * interval '1 day',
        date_trunc('day', now()),
        interval '1 day'
      )::date AS d
    )
    SELECT d::text AS day,
           COALESCE(AVG(e.mood), 0) AS avg_mood
    FROM days
    LEFT JOIN journal_entries e
      ON e.created_at >= d
     AND e.created_at < d + interval '1 day'
     ${whereUser}
    GROUP BY d
    ORDER BY d;
  `;

  const params = userId ? [userId, maxDays] : [maxDays]; // $1=userId (optional), $2=days
  const { rows } = await p.query(sql, params);
  return rows;
}
