import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import { readCollection, writeCollection } from "./lib/store.js";
import { savePhoto, readPhoto, sweepOrphans } from "./lib/photos.js";

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "./data";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export const app = express();
// Photos are stored separately now, so the collection document holds metadata only.
app.use(express.json({ limit: "5mb" }));
app.use(cors());

export async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/collection", async (req, res) => {
  try {
    res.json({ teas: await readCollection(DATA_DIR) });
  } catch (e) {
    res.status(500).json({ error: "Could not read the collection." });
  }
});

app.put("/api/collection", async (req, res) => {
  const body = req.body;
  const teas = Array.isArray(body) ? body : body && body.teas;
  if (!Array.isArray(teas)) {
    res.status(400).json({ error: "Expected { teas: [...] } or an array." });
    return;
  }
  try {
    await writeCollection(DATA_DIR, teas);
  } catch (e) {
    res.status(500).json({ error: "Could not save the collection." });
    return;
  }

  // Reclaim photos nothing points at any more. Deliberately after the write and
  // deliberately not awaited into the response path: a failed sweep wastes disk,
  // but a failed save loses data, and the client must not be told the save
  // failed because cleanup did.
  try {
    const referenced = teas.map((t) => t && t.photo).filter((p) => typeof p === "string");
    await sweepOrphans(DATA_DIR, referenced);
  } catch (e) {
    // Intentionally ignored; the next save will try again.
  }

  res.json({ ok: true, count: teas.length });
});

// Raw bytes, not base64: encoding a photo into JSON inflates it by a third,
// which is how the collection document outgrew its limit in the first place.
const photoBody = express.raw({ type: "image/*", limit: "10mb" });

app.post("/api/photos", photoBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    res.status(415).json({ error: "Send image bytes with an image/* content type." });
    return;
  }
  if (req.body.length === 0) {
    res.status(400).json({ error: "A photo must have a body." });
    return;
  }
  try {
    const id = await savePhoto(DATA_DIR, req.body);
    res.json({ id });
  } catch (e) {
    if (e.code === "TOO_LARGE") {
      res.status(413).json({ error: "That photo is too large." });
      return;
    }
    res.status(500).json({ error: "Could not store that photo." });
  }
});

app.get("/api/photos/:id", async (req, res) => {
  try {
    const bytes = await readPhoto(DATA_DIR, req.params.id);
    if (!bytes) {
      res.status(404).json({ error: "No such photo." });
      return;
    }
    res.set("Content-Type", "image/jpeg");
    // Ids are random and a photo's bytes never change, so this can be cached hard.
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.send(bytes);
  } catch (e) {
    res.status(500).json({ error: "Could not read that photo." });
  }
});

app.post("/api/scan", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "Label scanning isn't configured on the server." });
    return;
  }
  const { mediaType, b64, system } = req.body || {};
  if (!b64 || !mediaType) {
    res.status(400).json({ error: "Both mediaType and b64 are required." });
    return;
  }

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        system,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: "Read this tea packet and return the JSON described." },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    res.status(502).json({ error: "Could not reach the label reader." });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    res.status(upstream.status).json({ error: "The label reader rejected that request.", detail });
    return;
  }

  try {
    const data = await upstream.json();
    const text = (data && Array.isArray(data.content) ? data.content : [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: "Could not reach the label reader." });
  }
});

// Only bind the port when run directly, so the tests can import `app`.
const isDirectRun = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isDirectRun) {
  await ensureStore();
  app.listen(PORT, () => {
    console.log(`Tea Cabinet API listening on :${PORT} (data: ${DATA_DIR})`);
  });
}

export default app;
