// code/transcribe.js

// ───────────────────────────────────────────────────────────────────────────────
// 0) Load environment variables from `.env` and force them to override any
//    existing process env vars. This prevents a globally-set OPENAI_API_KEY
//    from shadowing your local .env values.
// ───────────────────────────────────────────────────────────────────────────────
import { config } from "dotenv";
config({ path: ".env", override: true });

// Standard Node + SDK imports
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

// DB helper (you created this in code/db.js). It exposes a connection pool and
// a simple insert function for the `journal_entries` table.
import { assertDb, insertEntry, endPool } from "../db.js";

// ───────────────────────────────────────────────────────────────────────────────
// 1) Read critical configuration from env and validate.
//    - OPENAI_API_KEY: your project-scoped key (sk-proj-...)
//    - OPENAI_PROJECT_ID: the project id (proj_...); required for sk-proj keys
//    - INPUT_FILE: path to the audio file to transcribe (default ./note.mp3)
// ───────────────────────────────────────────────────────────────────────────────
const apiKey = process.env.OPENAI_API_KEY;
const project = process.env.OPENAI_PROJECT_ID; // must look like "proj_abc123"
const inputFile = process.env.INPUT_FILE || "./note.mp3";

if (!apiKey) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}
if (!project) {
  console.error("Missing OPENAI_PROJECT_ID in .env (format: proj_...)");
  process.exit(1);
}
// Small sanity check to catch obviously malformed combos early.
if (apiKey.startsWith("sk-proj-") && !project.startsWith("proj_")) {
  console.error("Project key detected but OPENAI_PROJECT_ID looks invalid.");
  process.exit(1);
}

console.log("Using key prefix:", apiKey.slice(0, 12) + "...");

// ───────────────────────────────────────────────────────────────────────────────
// 2) Initialize the OpenAI SDK client.
//    IMPORTANT: We pass both the apiKey and the project so the SDK sends the
//    "OpenAI-Project: proj_..." header. Without this, project keys will 401.
// ───────────────────────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey,
  project,
  timeout: 90_000, // generous timeout for uploading audio files
});

// ───────────────────────────────────────────────────────────────────────────────
// 3) Basic input validation: ensure the audio file exists before we do work.
// ───────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(inputFile)) {
  console.error("Input file missing or not found:", inputFile);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────────
// 4) Prepare an output folder and filename for the JSON result.
//    - Files are grouped by date for easy manual inspection.
//    - You can switch to auto-increment (YYYY-MM-DD-1.json, etc.) later.
// ───────────────────────────────────────────────────────────────────────────────
const outputDir = path.resolve("./output");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const today = new Date().toISOString().split("T")[0]; // e.g. "2025-09-02"
const outputFile = path.join(outputDir, `${today}.json`);

// ───────────────────────────────────────────────────────────────────────────────
// 5) A tiny helper to await between retries (exponential backoff).
// ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────────────────────────────────────────
// 6) Transcription with basic retry logic.
//    - Streams are one-shot, so we pass a factory to create a new ReadStream
//      for each attempt.
//    - We retry only on network-ish / transient server errors.
// ───────────────────────────────────────────────────────────────────────────────
async function transcribeWithRetry(streamFactory, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file: streamFactory(),
      });
    } catch (err) {
      lastErr = err;

      const code = err?.code ?? err?.status ?? err?.name;
      const msg = err?.message ?? err?.response?.data ?? String(err);

      const retriable =
        [
          "ECONNRESET",
          "ETIMEDOUT",
          "ENOTFOUND",
          "EAI_AGAIN",
          408, // Request Timeout
          429, // Rate limit / quota (often safe to retry shortly)
          500,
          502,
          503,
          504,
        ].includes(code) || /network|fetch|timeout|socket|dns|proxy/i.test(msg);

      console.warn(
        `Attempt ${i}/${attempts} failed (${code || "no-code"}): ${msg}`
      );
      if (i < attempts && retriable) {
        await sleep(1000 * i); // backoff: 1s, 2s, ...
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// ───────────────────────────────────────────────────────────────────────────────
// 7) LLM analysis of the transcript.
//    - We keep the prompt simple and force JSON output so parsing is reliable.
//    - Model: gpt-4o-mini (cheap + fast + good enough for this task).
// ───────────────────────────────────────────────────────────────────────────────
async function analyzeTranscript(text) {
  const prompt = `
You are a mood tracker. Analyze the following journal entry.
Return JSON with the following fields:
- mood: integer 1–10 (10 = very positive, 1 = very negative)
- summary: short 1–2 sentence summary of the note
- advice: one practical tip to improve tomorrow

Journal entry:
"""${text}"""
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    // This instructs the API to return valid JSON in .message.content
    response_format: { type: "json_object" },
    // Optional caps (keeps costs tiny and responses tight):
    // max_tokens: 200,
    // temperature: 0.2,
  });

  return JSON.parse(completion.choices[0].message.content);
}

// ───────────────────────────────────────────────────────────────────────────────
// 8) Main flow:
//    - Start timer (for ms_elapsed).
//    - Transcribe audio.
//    - Analyze transcript.
//    - Build a result object.
//    - Save JSON file for debugging/manual review.
//    - Compute rough token estimates + cost and INSERT into Postgres (Neon).
//    - Close the DB pool gracefully.
// ───────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const started = Date.now();
    console.log("Transcribing:", inputFile);
    const dbNow = await assertDb();
    console.log("DB ok:", dbNow);

    // Streams are one-shot → wrap in a factory so each retry gets a fresh stream.
    const streamFactory = () => fs.createReadStream(path.resolve(inputFile));

    // 8.1) ASR (audio -> text)
    const transcription = await transcribeWithRetry(streamFactory);

    // 8.2) LLM analysis (mood/summary/advice)
    const analysis = await analyzeTranscript(transcription.text);

    // 8.3) Build the result object that we also write to disk (nice for audits).
    const result = {
      file: path.resolve(inputFile), // absolute path to the audio file processed
      text: transcription.text, // the transcript string
      analysis, // { mood, summary, advice }
      raw: transcription, // original API response (remove later if too large)
      ms: Date.now() - started, // end-to-end runtime for the session
      created_at: new Date().toISOString(),
    };

    // 8.4) Save to output/YYYY-MM-DD.json (handy local artifact for debugging).
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), "utf-8");

    // 8.5) Console summary (good UX while you iterate).
    console.log("\n--- Transcript ---\n" + result.text + "\n");
    console.log("--- Mood Analysis ---");
    console.log("Mood:", analysis.mood);
    console.log("Summary:", analysis.summary);
    console.log("Advice:", analysis.advice);
    console.log("\nSaved file:", outputFile, `(${result.ms} ms)`);

    // ───────────────────────────────────────────────────────────────────────────
    // 8.6) Estimate token usage + cost for the analysis call only.
    //      We *roughly* assume ~4 chars per token as a heuristic. Good enough
    //      for budgeting; if you need precision later, parse usage from API
    //      responses when available.
    //      Pricing (as of now): gpt-4o-mini → $0.60 / 1M input, $2.40 / 1M output.
    // ───────────────────────────────────────────────────────────────────────────
    const inputTokens = Math.ceil((result.text?.length || 0) / 4);
    const outputTokens = Math.ceil(
      JSON.stringify(result.analysis || {}).length / 4
    );
    const costInput = (inputTokens / 1_000_000) * 0.6;
    const costOutput = (outputTokens / 1_000_000) * 2.4;
    const costEstimate = Number((costInput + costOutput).toFixed(4)); // rounded USD

    // ───────────────────────────────────────────────────────────────────────────
    // 8.7) Insert the entry into Postgres (Neon).
    //      Requires:
    //        - DATABASE_URL in .env
    //        - code/db.js with a Pool and insertEntry(e) as we defined earlier
    //        - journal_entries table created (see earlier SQL)
    // ───────────────────────────────────────────────────────────────────────────
    const row = await insertEntry({
      audio_path: result.file,
      transcript: result.text,
      mood: result.analysis?.mood,
      summary: result.analysis?.summary,
      advice: result.analysis?.advice,
      model_asr: "gpt-4o-mini-transcribe",
      model_analysis: "gpt-4o-mini",
      ms_elapsed: result.ms,
      project_id: process.env.OPENAI_PROJECT_ID,
      tokens_input: inputTokens,
      tokens_output: outputTokens,
      duration_seconds: null, // you can fill this later via ffprobe if you want
      cost_estimate_usd: costEstimate,
    });

    console.log("✅ Saved to DB:", row.id, "at", row.created_at);

    // 8.8) Always end the pool explicitly in short-lived scripts to avoid
    //      hanging Node processes due to open DB connections.
    await endPool();
  } catch (err) {
    // Centralized error logging with helpful fields shown if present.
    console.error("Transcription/Analysis failed (final):", {
      name: err?.name,
      code: err?.code,
      status: err?.status,
      message: err?.message,
      data: err?.response?.data,
    });

    // Attempt a graceful DB shutdown just in case the pool was initialized.
    try {
      await endPool();
    } catch {}

    process.exit(1);
  }
})();
