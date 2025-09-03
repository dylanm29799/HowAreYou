// code/transcribe.js
import { config } from "dotenv";
config({ path: ".env", override: true }); // ensure .env wins

import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

// --- ENV & client setup ---
const apiKey = process.env.OPENAI_API_KEY;
const project = process.env.OPENAI_PROJECT_ID; // proj_xxx

if (!apiKey) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}
if (!project) {
  console.error("Missing OPENAI_PROJECT_ID in .env (format: proj_...)");
  process.exit(1);
}
if (apiKey.startsWith("sk-proj-") && !project.startsWith("proj_")) {
  console.error("Project key detected but OPENAI_PROJECT_ID looks invalid.");
  process.exit(1);
}

console.log("Using key prefix:", apiKey.slice(0, 12) + "...");

const openai = new OpenAI({
  apiKey,
  project, // required for sk-proj- keys
  timeout: 90_000,
});

// --- Input file checks ---
const inputFile = process.env.INPUT_FILE || "./note.mp3";
if (!fs.existsSync(inputFile)) {
  console.error("Input file missing or not found:", inputFile);
  process.exit(1);
}

// --- Ensure output dir & filename ---
const outputDir = path.resolve("./output");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const today = new Date().toISOString().split("T")[0]; // e.g. 2025-09-02
const outputFile = path.join(outputDir, `${today}.json`);

// --- Transcribe with basic retry for flaky networks ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
          408,
          429,
          500,
          502,
          503,
          504,
        ].includes(code) || /network|fetch|timeout|socket|dns|proxy/i.test(msg);
      console.warn(
        `Attempt ${i}/${attempts} failed (${code || "no-code"}): ${msg}`
      );
      if (i < attempts && retriable) {
        await sleep(1000 * i);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// --- Analyze transcript with GPT-4o-mini ---
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
    response_format: { type: "json_object" },
  });

  return JSON.parse(completion.choices[0].message.content);
}

// --- Main flow ---
(async () => {
  try {
    const started = Date.now();
    console.log("Transcribing:", inputFile);

    const streamFactory = () => fs.createReadStream(path.resolve(inputFile));
    const transcription = await transcribeWithRetry(streamFactory);

    const analysis = await analyzeTranscript(transcription.text);

    const result = {
      file: path.resolve(inputFile),
      text: transcription.text,
      analysis, // { mood, summary, advice }
      raw: transcription,
      ms: Date.now() - started,
      created_at: new Date().toISOString(),
    };

    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), "utf-8");

    console.log("\n--- Transcript ---\n" + result.text + "\n");
    console.log("--- Mood Analysis ---");
    console.log("Mood:", analysis.mood);
    console.log("Summary:", analysis.summary);
    console.log("Advice:", analysis.advice);
    console.log("\nSaved:", outputFile, `(${result.ms} ms)`);
  } catch (err) {
    console.error("Transcription failed (final):", {
      name: err?.name,
      code: err?.code,
      status: err?.status,
      message: err?.message,
      data: err?.response?.data,
    });
    process.exit(1);
  }
})();
