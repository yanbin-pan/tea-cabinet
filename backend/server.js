import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "./data";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const DATA_FILE = path.join(DATA_DIR, "collection.json");
const TMP_FILE = `${DATA_FILE}.tmp`;

export const app = express();
// Label photos travel as base64 data URLs, so the body limit has to be generous.
app.use(express.json({ limit: "15mb" }));
app.use(cors());

export async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch (e) {
    await fs.writeFile(DATA_FILE, JSON.stringify({ teas: [] }), "utf8");
  }
}

export async function readCollection() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.teas)) return data.teas;
    return [];
  } catch (e) {
    return [];
  }
}

// Atomic write: fill a temp file, then rename over the real one. A crash
// mid-write leaves the previous collection intact rather than a half file.
export async function writeCollection(teas) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = { app: "The Tea Cabinet", version: 1, teas };
  await fs.writeFile(TMP_FILE, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(TMP_FILE, DATA_FILE);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/collection", async (req, res) => {
  try {
    const teas = await readCollection();
    res.json({ teas });
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
    await writeCollection(teas);
    res.json({ ok: true, count: teas.length });
  } catch (e) {
    res.status(500).json({ error: "Could not save the collection." });
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
    console.log(`Tea Cabinet API listening on :${PORT} (data: ${DATA_FILE})`);
  });
}

export default app;
