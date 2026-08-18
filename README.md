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

### API

| Method | Path              | Behaviour                                                          |
| ------ | ----------------- | ------------------------------------------------------------------ |
| `GET`  | `/api/health`     | `{ ok: true }` — used by container health checks.                   |
| `GET`  | `/api/collection` | `{ teas: [...] }`.                                                  |
| `PUT`  | `/api/collection` | Accepts `{teas:[...]}` or a bare array. Returns `{ok:true,count}`.  |
| `POST` | `/api/scan`       | `{mediaType,b64}` → `{text}`. `429` past quota, `503` if unconfigured. |

### Configuration

All backend settings are environment variables:

| Variable                 | Default              | Purpose                                                        |
| ------------------------ | -------------------- | -------------------------------------------------------------- |
| `PORT`                   | `8080`               | Port the API listens on.                                        |
| `DATA_DIR`               | `./data`             | Directory holding `collection.json`.                            |
| `ANTHROPIC_API_KEY`      | *(empty)*            | Enables label scanning. Omit to disable it.                     |
| `ANTHROPIC_MODEL`        | `claude-sonnet-4-6`  | Model used to read labels.                                      |
| `SCAN_DAILY_PER_CALLER`  | `25`                 | Scans one caller may make per UTC day.                          |
| `SCAN_DAILY_TOTAL`       | `250`                | Scans the instance may make per UTC day, across everyone.       |
| `SCAN_MAX_IMAGE_BYTES`   | `2097152`            | Largest image accepted for a scan, decoded.                     |
| `PUBLIC_MODE`            | *(off)*              | Serve anonymous scanning only, and store nothing. See below.    |

### Keeping the label reader from becoming an expensive hobby

`/api/scan` is the only route that costs money per call, and it is the only one worth
protecting for that reason. Three things bound the spend:

**A daily quota, not a request rate.** The ingress already limits requests per second
(`k8s/60-rate-limits.yaml`), but a rate limit is not a spend limit — 60/min sustained is
around 86,000 scans a day, forever. The backend counts scans per UTC day instead, per
caller and in total. Both must pass. The per-caller limit handles the ordinary case; the
global one is what actually bounds the invoice, because per-caller counting keys on an
address the caller chooses.

The counters are in memory, so **the real ceiling is `SCAN_DAILY_TOTAL` × replicas.**
Size the number for one replica. A shared counter on the NFS volume was the alternative
and it is worse: read-modify-write from two replicas loses increments exactly when
concurrency is highest, which is when the limit matters.

**A fixed prompt.** The system prompt used to arrive in the request body. That made the
endpoint a general-purpose model proxy on whoever owns the key — a quota bounds how many
calls a stranger can make, but only a server-owned prompt bounds what they can make them
do. It now lives in `backend/lib/scan.js` and the client sends image bytes and nothing else.

**A size ceiling.** The quota bounds the number of scans; `SCAN_MAX_IMAGE_BYTES` bounds
what one scan can cost. The frontend re-encodes every photo to a 1600px JPEG first, which
lands well under the default.

Nothing upstream is forwarded verbatim. A provider error is logged with its detail and
answered with a status chosen for what the client should do about it — a rejected API key
becomes a 503 ("scanning isn't configured"), not the 401 the frontend reads as an expired
login.

### Public mode

`PUBLIC_MODE=1` turns the backend into a label reader with no cabinet: `/api/scan` is
served to anonymous callers, quota'd by address, and the routes that touch stored data
are **not mounted at all**. They answer 404 because they do not exist, not 401 because
you are not signed in — a public instance holds no collections and no photos, so there is
nothing there to leak.

Pair it with a frontend built with `VITE_LOCAL_ONLY=1` (below). Cloudflare Access is not
required in this mode, and is still mandatory in every other mode.

The whole stack runs from one file:

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose -f docker-compose.public.yml up --build
```

That is the version you can hand to a stranger. What it does **not** yet include is the
deployment: a second hostname, its DNS and TLS, and a Kubernetes overlay that sets
`PUBLIC_MODE` and builds the frontend with `VITE_LOCAL_ONLY=1`. The manifests in `k8s/`
still describe the private instance only.

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

## Local-only builds

`VITE_LOCAL_ONLY=1 npm run build` produces a frontend whose collection and photos live
in the browser and nowhere else. There is no account, no cabinet on the server, and the
only request it makes is `/api/scan`.

```bash
cd frontend && VITE_LOCAL_ONLY=1 npm run build
```

This is what a public trial instance is for: someone can use the app without signing up,
and the operator stores none of their data. Three things behave differently:

- **Photos are stored inline**, downscaled to 700px, instead of being uploaded and
  referenced by id. `localStorage` gives the whole collection a few megabytes, and a
  1600px JPEG fills that after about a dozen teas. The copy that gets *scanned* is still
  full-size — the reader is working from small print, and trading accuracy for storage
  on the one operation that costs money is the wrong way round.
- **A save that storage rejects throws**, rather than being swallowed as it is in a
  server build. There the local copy is a convenience behind the server's authority;
  here it is the only copy, and a full quota is data loss the user has to hear about.
- **Export is the only backup.** Clearing site data destroys the collection. The header
  says so permanently rather than in a toast that scrolls away.

Importing a server export into a local-only build drops photos, which are ids pointing at
a cabinet this build cannot read; they are counted and reported rather than left to render
as broken images. Everything else imports normally.

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
cd frontend && npm run build   # a real production build is the frontend's gate
```

The backend suite covers the parts most likely to lose data quietly: that a corrupt or
missing file reads as an empty collection rather than throwing, that a bare array on disk
is still understood, and that no temporary file survives a write.

It also covers the parts most likely to lose money quietly: that a scan the provider
never answered is refunded to the caller's quota while one it did answer is not, that a
client-supplied system prompt is ignored, that a rejected API key is not reported to the
user as an expired login, and that public mode does not mount a route which could serve
one person's cabinet to another.

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
