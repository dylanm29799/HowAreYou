// db.js
import { config } from "dotenv";
config({ path: ".env", override: true });

import pg from "pg";
const { Pool } = pg;

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL.includes("sslmode=")
        ? process.env.DATABASE_URL
        : `${process.env.DATABASE_URL}${
            process.env.DATABASE_URL.includes("?") ? "&" : "?"
          }sslmode=require`,
      ssl: { rejectUnauthorized: false },
      keepAlive: true,
    });
  }
  return pool;
}

export async function insertEntry(e) {
  const p = getPool();
  const sql = `
    INSERT INTO journal_entries
      (audio_path, transcript, mood, summary, advice,
       model_asr, model_analysis, ms_elapsed, project_id,
       tokens_input, tokens_output, duration_seconds, cost_estimate_usd)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id, created_at
  `;
  const vals = [
    e.audio_path ?? null,
    e.transcript,
    e.mood ?? null,
    e.summary ?? null,
    e.advice ?? null,
    e.model_asr ?? null,
    e.model_analysis ?? null,
    e.ms_elapsed ?? null,
    e.project_id ?? null,
    e.tokens_input ?? null,
    e.tokens_output ?? null,
    e.duration_seconds ?? null,
    e.cost_estimate_usd ?? null,
  ];
  const { rows } = await p.query(sql, vals);
  return rows[0];
}

export async function listEntries(limit = 20) {
  const p = getPool();
  const { rows } = await p.query(
    `SELECT id, created_at, mood, summary, advice FROM journal_entries ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
