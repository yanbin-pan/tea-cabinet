# The Tea Cabinet

A personal inventory for Chinese tea. Photograph a packet and the app reads the label —
translating it where needed — then fills in type, origin, brewing guidance, grade and
rarity, and files it in your cabinet.

![storage: JSON file](https://img.shields.io/badge/storage-JSON%20file-8A5A3C) ![runs on: Docker](https://img.shields.io/badge/runs%20on-Docker-4A5D3A)

---

## Why it exists

Loose-leaf tea arrives in packets labelled in Chinese, often with the useful part — the
mountain, the year, the oxidation level, how long to steep it — printed in small type
among marketing copy. A month later the packet is open, the label is creased, and you are
guessing at water temperature.

This keeps the answer. Photograph the packet once, and what the label said is searchable
afterwards, in English, from your phone in the kitchen.

## What it does

- **Scan a label.** Point a camera at the packet; the fields come back filled in.
- **Type them yourself.** Scanning is optional — every field is editable, and the app is
  fully usable with no scanning configured at all.
- **Search and filter** across name, type, origin and notes.
- **Record brewing guidance** — water temperature, steep time, leaf quantity.
- **Import and export** the whole collection as JSON. Import matches on `id` and updates
  in place, so re-importing a backup merges rather than duplicates.
- **Works offline.** The browser keeps a local mirror, so the collection stays readable
  when the server is unreachable.

---

## How it works

Two containers and one file.

```
browser ──► frontend (nginx serving a static React build)
                │  /api/* proxied
                ▼
            backend (Node 20 + Express)
                │
                ├── /app/data/collection.json   ← the whole database
                └── label-reading API           ← key stays server-side
```

**There is no database.** The entire collection is one JSON file. That is a deliberate
choice for a dataset that is realistically a few hundred entries: it is trivially
backed up, human-readable, and diffable.

Writes are **atomic** — the server fills a temporary file and renames it over the real
one, so a crash mid-save leaves the previous collection intact rather than a truncated
file. The frontend owns all merge, dedupe and ID logic and `PUT`s the authoritative list;
the server stores what it is given.

**Label scanning never exposes an API key to the browser.** The client posts image bytes
to `POST /api/scan` and the backend attaches the credential server-side. With no key
configured the endpoint answers `503` and the UI simply asks you to fill the fields in
by hand — the app degrades rather than breaks.

**The page loads nothing from a third-party host.** Inter is bundled and served from the
app's own origin, and Chinese glyphs use the device's own serif CJK face rather than a
webfont. This is not a performance nicety: Google's font hosts are blocked in mainland
China, and a blocked `@import` does not fail fast — it hangs until the connect times out
while the browser withholds rendering. For an app about Chinese tea, that broke the page
for precisely the people most likely to be reading it.

### API

| Method | Path              | Behaviour                                                          |
| ------ | ----------------- | ------------------------------------------------------------------ |
| `GET`  | `/api/health`     | `{ ok: true }` — used by container health checks.                   |
| `GET`  | `/api/collection` | `{ teas: [...] }`.                                                  |
| `PUT`  | `/api/collection` | Accepts `{teas:[...]}` or a bare array. Returns `{ok:true,count}`.  |
| `POST` | `/api/scan`       | `{mediaType,b64,system}` → `{text}`. `503` if no key is configured.  |

### Configuration

All backend settings are environment variables:

| Variable            | Default              | Purpose                                        |
| ------------------- | -------------------- | ---------------------------------------------- |
| `PORT`              | `8080`               | Port the API listens on.                        |
| `DATA_DIR`          | `./data`             | Directory holding `collection.json`.            |
| `ANTHROPIC_API_KEY` | *(empty)*            | Enables label scanning. Omit to disable it.     |
| `ANTHROPIC_MODEL`   | `claude-sonnet-4-6`  | Model used to read labels.                      |

---

## Running it with Docker

The quickest way to a working instance:

```bash
docker compose up --build
```

The app is then at <http://localhost:8081>, with the API on `:8080`. The collection
persists in the `tea-data` named volume, so it survives `docker compose down`.

To enable label scanning, supply a key:

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
```

Everything works without one; scanning simply stays off.

### Without Compose

```bash
docker network create tea

docker run -d --name tea-backend --network tea \
  -v tea-data:/app/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  $(docker build -q ./backend)

docker run -d --name tea-frontend --network tea -p 8081:80 \
  $(docker build -q ./frontend)
```

The frontend resolves the backend by the container name `backend`, so keep that name or
adjust `frontend/nginx.conf` to match.

### Your data, and backing it up

The whole database is one file inside the volume:

```bash
# back up
docker compose exec backend cat /app/data/collection.json > tea-backup.json

# restore
docker compose cp tea-backup.json backend:/app/data/collection.json
docker compose restart backend
```

You can also restore through the app's **Import** button, which merges by `id` and is
the safer option if the collection has changed since the backup.

---

## Local development

Two terminals, no containers:

```bash
cd backend  && npm install && npm run dev    # :8080
cd frontend && npm install && npm run dev    # :5173, proxies /api to :8080
```

Set `ANTHROPIC_API_KEY` in the backend terminal to exercise label scanning.

### Tests

```bash
cd backend  && npm test        # node:test — persistence and routes, no network needed
cd frontend && npm test        # vitest — API client, translations, font sourcing
cd frontend && npm run build   # a real production build is the last gate
```

The backend suite covers the parts most likely to lose data quietly: that a corrupt or
missing file reads as an empty collection rather than throwing, that a bare array on disk
is still understood, and that no temporary file survives a write.

---

## Repository layout

```
frontend/   React 18 + Vite 5 app, nginx serving config, Dockerfile
backend/    Express 4 API (ES modules), node:test suite, Dockerfile
k8s/        optional Kubernetes manifests, for running it on a cluster
.github/    test and image-build workflows
reference/  the original single-file UI prototype and the build spec
```

Self-hosting on Kubernetes is optional and entirely separate from the Docker path above —
the manifests in `k8s/` are provided as a starting point and assume an ingress controller
and a shared storage class.
