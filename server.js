// server.js
import { config } from "dotenv";
config({ path: ".env", override: true });

import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import OpenAI from "openai";
import { fileURLToPath } from "node:url";
import { insertEntry, listEntries } from "./db.js";

// ── ESM path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Pick a public directory that actually exists in this build
const publicCandidates = [
  path.join(__dirname, "code", "public"),
  path.join(__dirname, "public"),
];
const publicDir =
  publicCandidates.find((p) => fs.existsSync(p)) ?? publicCandidates[0];

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

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true, publicDir }));

// ── APIs
app.get("/api/entries", async (_req, res) => {
  try {
    const rows = await listEntries(20);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

// Upload → transcribe → analyze → save
app.post("/api/journal", upload.single("audio"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "No file uploaded" });

  const started = Date.now();
  try {
    // 1) Transcribe (filename helps the API know the format)
    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(path.resolve(filePath)),
      filename: req.file.originalname,
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
