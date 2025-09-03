// server.js
import { config } from "dotenv";
config({ path: ".env", override: true });

import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { insertEntry, listEntriesByLimit, getDailyMood } from "./db.js";

// ── ESM path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Pick a public directory that actually exists in this build
const publicCandidates = [
  path.join(__dirname, "code", "public"),
  path.join(__dirname, "public"),
];

const publicDir = path.join(__dirname, "public");

// ── Ensure uploads dir exists (ephemeral on hosts like Railway)
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// ── Multer storage: keep original extension so OpenAI recognizes type
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeBase = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeBase.endsWith(ext) ? safeBase : safeBase + ext);
  },
});
const upload = multer({ storage });

const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_PROJECT_ID) {
  console.error("Missing OPENAI_API_KEY or OPENAI_PROJECT_ID");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  project: process.env.OPENAI_PROJECT_ID,
  timeout: 90_000,
});

const app = express();

// ── Serve static frontend
app.use(express.static(publicDir));
// Root route fallback (returns index.html if present, else helpful msg)
app.get("/", (_req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).send(`index.html not found in ${publicDir}`);
});

app.use(express.json());

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true, publicDir }));

// GET entries (feed)
app.get("/api/entries", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const rows = await listEntriesByLimit(limit);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_list_entries" });
  }
});

// GET daily mood stats (last N days)
app.get("/api/stats/daily-mood", async (req, res) => {
  try {
    const days = parseInt(req.query.days || "14", 10);
    // If/when you add auth, pass userId from session here.
    const rows = await getDailyMood(days /*, userId*/);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_get_stats" });
  }
});

// POST a quick text entry (no audio)
app.post("/api/entries", async (req, res) => {
  try {
    const { mood, summary, advice, transcript } = req.body || {};
    const row = await insertEntry({
      // user_id: sessionUserId ?? null, // add this when auth is wired
      mood: mood ?? null,
      summary: summary ?? null,
      advice: advice ?? null,
      transcript: transcript ?? null,
      audio_path: null,
      model_asr: null,
      model_analysis: null,
      ms_elapsed: null,
      project_id: process.env.OPENAI_PROJECT_ID || null,
      tokens_input: null,
      tokens_output: null,
      duration_seconds: null,
      cost_estimate_usd: null,
    });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_insert_entry" });
  }
});

// Upload → transcribe → analyze → save
app.post("/api/journal", upload.single("audio"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "No file uploaded" });

  const started = Date.now();
  try {
    // 1) Transcribe (filename helps the API know the format)
    // Map mimetype -> filename hint for OpenAI
    function guessApiFilename(mime, fallback = "audio.mp3") {
      if (!mime) return fallback;
      if (/mp4|aac/i.test(mime)) return "audio.mp4"; // iOS MediaRecorder
      if (/webm/i.test(mime)) return "audio.webm";
      if (/ogg|opus/i.test(mime)) return "audio.ogg";
      if (/mpeg|mp3/i.test(mime)) return "audio.mp3";
      if (/wav/i.test(mime)) return "audio.wav";
      return fallback;
    }

    const apiFilename = guessApiFilename(
      req.file?.mimetype,
      req.file?.originalname || "audio.mp3"
    );

    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(path.resolve(filePath)),
      filename: apiFilename, // <- key fix
    });

    // 2) Analyze
    const prompt = `
You are a mood tracker. Analyze the following journal entry.
Return JSON with fields: mood (1-10), summary (1-2 sentences), advice (one practical tip).
Entry:
"""${transcription.text}"""`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const analysis = JSON.parse(completion.choices[0].message.content);

    // 3) Rough token/cost estimate for analysis call (transcription billed separately)
    const inputTokens = Math.ceil((transcription.text?.length || 0) / 4);
    const outputTokens = Math.ceil(JSON.stringify(analysis).length / 4);
    const costInput = (inputTokens / 1_000_000) * 0.6;
    const costOutput = (outputTokens / 1_000_000) * 2.4;
    const costEstimate = Number((costInput + costOutput).toFixed(4));

    // 4) Save to DB
    const row = await insertEntry({
      audio_path: filePath,
      transcript: transcription.text,
      mood: analysis.mood,
      summary: analysis.summary,
      advice: analysis.advice,
      model_asr: "gpt-4o-mini-transcribe",
      model_analysis: "gpt-4o-mini",
      ms_elapsed: Date.now() - started,
      project_id: process.env.OPENAI_PROJECT_ID,
      tokens_input: inputTokens,
      tokens_output: outputTokens,
      duration_seconds: null,
      cost_estimate_usd: costEstimate,
    });

    res.json({
      id: row.id,
      created_at: row.created_at,
      transcript: transcription.text,
      analysis,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "Processing failed" });
  } finally {
    // Clean up uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Web prototype running on http://localhost:${PORT}`);
  console.log(`Serving static from: ${publicDir}`);
});
