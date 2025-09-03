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

// --- Resolve absolute paths for ESM (so static serving works) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
// instead of "const upload = multer({ dest: ... })"
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "uploads")); // keep uploads folder
  },
  filename: (req, file, cb) => {
    // Preserve extension (e.g., .mp3, .wav)
    const ext = path.extname(file.originalname);
    const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeName.endsWith(ext) ? safeName : safeName + ext);
  },
});

const upload = multer({ storage });

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

// --- Serve static frontend from /public ---
const publicDir = path.join(__dirname, "code", "public");
app.use(express.static(publicDir));

// Optional explicit root route (helps if static middleware is bypassed)
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// --- APIs ---

// GET recent entries
app.get("/api/entries", async (_req, res) => {
  try {
    const rows = await listEntries(20);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

// POST journal (upload audio -> transcribe -> analyze -> save)
app.post("/api/journal", upload.single("audio"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "No file uploaded" });

  const started = Date.now();
  try {
    // 1) Transcribe
    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(path.resolve(filePath)),
      filename: req.file.originalname, // 👈 tell OpenAI the original name/extension
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

    // 3) Estimate token costs (rough heuristic)
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
    // optional: cleanup uploaded file
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Web prototype running on http://localhost:${PORT}`);
  console.log(`Serving static from: ${publicDir}`);
});
