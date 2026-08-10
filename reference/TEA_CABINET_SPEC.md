# Tea Cabinet — Build Specification

You are building a deployable, self-hosted web application called **The Tea Cabinet**:
a personal Chinese-tea inventory app. Build the complete repository from this spec,
install dependencies, verify it builds, run the tests you write, and make an initial
git commit. Work in the current repository directory.

I already have an existing single-file React implementation of the UI (an artifact).
If a file `SOURCE_APP.jsx` exists in the repo root or in `./reference/`, treat it as
the **authoritative source of the frontend UI** and adapt it per the "Frontend" section
below. If it does **not** exist, build the frontend fresh to match the "Frontend
behaviour" section, and stop to tell me it was missing so I can paste it in.

---

## 1. Goals & non-goals

**Goals**
- Turn the existing React tea-inventory UI into a proper two-tier app: static frontend + small backend.
- Persist data as a JSON file on disk (a mounted volume in production). No database yet.
- Keep the Anthropic API key **server-side**: the label-scanning feature must call Anthropic
  through the backend, never from the browser.
- Ship Docker images for **linux/arm64** (Raspberry Pi 4).
- Deploy to a **k3s** cluster (which bundles Traefik ingress and a `local-path` storage class).
- CI/CD via GitHub Actions building and pushing images to GHCR on push to `main`.

**Non-goals (do not build these)**
- No database, no auth/login, no multi-user accounts.
- No cloud-vendor-specific infra (no AWS/GCP/Azure manifests).
- Do not expose the Anthropic key to the client under any circumstance.

---

## 2. Tech stack (use exactly these)

- **Frontend:** React 18 + Vite 5, `lucide-react` for icons. Built to static files, served by Nginx.
- **Backend:** Node 20, Express 4 (ES modules, `"type": "module"`). Dependencies: `express`, `cors`. No TypeScript.
- **Containers:** Node 20 `-slim` base for builds; `nginx:1.27-alpine` to serve the frontend.
- **Orchestration:** plain Kubernetes YAML targeting k3s (Traefik ingress, `local-path` PVC).
- **CI:** GitHub Actions with `docker/build-push-action`, QEMU for arm64, push to `ghcr.io`.

Owner/registry assumptions (make these configurable but default to):
- GitHub owner: `yanbin-pan` (lowercase). Images: `ghcr.io/yanbin-pan/tea-cabinet-backend`
  and `ghcr.io/yanbin-pan/tea-cabinet-frontend`.
- Ingress host placeholder: `tea.example.com` (I will change it to my Cloudflare domain).

---

## 3. Repository layout to produce

```
.
├── frontend/
│   ├── src/
│   │   ├── App.jsx           # the tea UI, adapted to use the backend API
│   │   └── main.jsx          # React entry
│   ├── index.html
│   ├── vite.config.js        # dev proxy /api -> localhost:8080
│   ├── nginx.conf            # serve SPA + proxy /api -> backend:8080
│   ├── Dockerfile            # multi-stage: node build -> nginx serve
│   ├── package.json
│   └── .dockerignore
├── backend/
│   ├── server.js             # Express: JSON CRUD + Anthropic scan proxy
│   ├── server.test.js        # tests (node:test) for persistence + routes
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── k8s/
│   ├── 00-namespace.yaml
│   ├── 10-pvc.yaml
│   ├── 20-backend-secret.example.yaml
│   ├── 30-backend.yaml
│   ├── 40-frontend.yaml
│   └── 50-ingress.yaml
├── .github/workflows/ci.yaml
├── docker-compose.yml        # local dev: build+run both, volume for data
├── .gitignore
└── README.md
```

---

## 4. Backend specification (`backend/server.js`)

Express server, ES modules. Config from env with these defaults:
- `PORT` = `8080`
- `DATA_DIR` = `./data`  → data file is `${DATA_DIR}/collection.json`
- `ANTHROPIC_API_KEY` = `""`
- `ANTHROPIC_MODEL` = `claude-sonnet-4-6`

Middleware: `express.json({ limit: "15mb" })` (label photos are base64 data URLs), and `cors()`.

**Persistence helpers**
- `ensureStore()` — `mkdir -p` the data dir; if the data file is missing, create it as `{"teas":[]}`.
- `readCollection()` — read + JSON.parse. Tolerate either a bare array or `{teas:[...]}`. On any error return `[]`.
- `writeCollection(teas)` — **atomic write**: write to `collection.json.tmp` then `rename` over the
  real file, so a crash mid-write can never corrupt it. Persist as
  `{"app":"The Tea Cabinet","version":1,"teas":[...]}` pretty-printed.

**Routes**
- `GET /api/health` → `{ ok: true }`.
- `GET /api/collection` → `{ teas: [...] }` from `readCollection()`. 500 on failure.
- `PUT /api/collection` → body is `{teas:[...]}` **or** a bare array. Validate it's an array;
  400 if not. Call `writeCollection`. Respond `{ ok: true, count }`. The **frontend owns all
  merge/dedupe/ID logic** and sends the authoritative full list; the server just persists it.
- `POST /api/scan` → body `{ mediaType, b64, system }`.
  - If `ANTHROPIC_API_KEY` is empty → 503 `{ error: "Label scanning isn't configured on the server." }`.
  - If `b64` or `mediaType` missing → 400.
  - Otherwise call `https://api.anthropic.com/v1/messages` with headers
    `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`, body:
    ```json
    {
      "model": "<ANTHROPIC_MODEL>",
      "max_tokens": 1000,
      "system": "<system>",
      "messages": [{ "role": "user", "content": [
        { "type": "image", "source": { "type": "base64", "media_type": "<mediaType>", "data": "<b64>" } },
        { "type": "text", "text": "Read this tea packet and return the JSON described." }
      ]}]
    }
    ```
  - On upstream non-OK → forward the status with `{ error, detail }`.
  - On success → extract the concatenated text blocks from `data.content` (filter
    `type === "text"`, join with newlines, trim) and return `{ text }`. The frontend parses
    the JSON object out of that text.
  - On network failure → 502 `{ error: "Could not reach the label reader." }`.

Log on listen: ``Tea Cabinet API listening on :${PORT} (data: ${DATA_FILE})``.

**Backend tests (`backend/server.test.js`, using built-in `node:test` + `node:assert`)**
Write tests that do not require network or a real API key:
- `readCollection` returns `[]` when the file is absent.
- `writeCollection` then `readCollection` round-trips a small array; assert the on-disk file
  contains the `{app,version,teas}` shape.
- `writeCollection` is atomic: after a write, no `.tmp` file remains.
- `GET /api/health` returns `{ok:true}` (start the app on an ephemeral port).
- `GET /api/collection` returns `{teas:[]}` initially; `PUT` then `GET` reflects the new list.
- `POST /api/scan` with no `ANTHROPIC_API_KEY` set returns 503.
Use a temp `DATA_DIR` (e.g. under the OS temp dir) so tests don't touch real data. Refactor
`server.js` if needed to export the `app` and the helpers for testing (e.g. only call
`app.listen` when run directly), so tests can import without binding the port twice.
Add `"test": "node --test"` to backend `package.json` scripts.

---

## 5. Frontend specification

### If `SOURCE_APP.jsx` is provided
Copy it to `frontend/src/App.jsx` and make **exactly these** changes, leaving all UI, styling,
and component logic otherwise intact:

1. **Remove artifact storage.** Delete any use of `window.storage` and the Claude-artifact
   persistence. Replace the `persist()` and `hydrate()` functions with backend-backed versions:
   - Introduce `const API_BASE = import.meta.env.VITE_API_BASE || "";`
   - `persist(collection)`: keep a `localStorage` mirror (best-effort) **and** `PUT ${API_BASE}/api/collection`
     with `{ teas: collection }`. Swallow network errors (the mirror covers a blip).
   - `hydrate()`: `GET ${API_BASE}/api/collection`; if ok and `data.teas` is an array, return it.
     Fall back to the `localStorage` mirror only if the backend is unreachable. Else return `null`.
2. **Route scanning through the backend.** In the label-reading function, instead of calling
   `https://api.anthropic.com/v1/messages` directly from the browser, `POST ${API_BASE}/api/scan`
   with `{ mediaType, b64, system: SCAN_SYSTEM }`. Keep the existing retry/backoff loop
   (3 attempts, `600 * attempt` ms backoff, retry on network / 429 / 5xx). Parse the returned
   `{ text }` with the existing JSON-extraction helper. **No API key anywhere in frontend code.**
3. Ensure it's a standard Vite React app: `export default function App()`, importing React and
   `lucide-react` normally. Remove any artifact-only globals.
4. Do **not** weaken any of the existing hardening (image normalisation, atomic-ish import,
   dedupe, caffeine chart). Preserve them verbatim.

### If `SOURCE_APP.jsx` is NOT provided — frontend behaviour to implement
Build a single-page React app, a Chinese-tea inventory, with:
- A responsive card grid of teas; each card shows name (English + Chinese), a type colour tag,
  and grade. Type filter chips and a text search box.
- Add / Edit / Detail modals. Tea fields: `id, englishName, chineseName, type, flavourNotes,
  brewTemp, steepTime, origin, harvestYear, rarity, grade, caffeine, reasoning, photo, createdAt`.
- Constants:
  - `TEA_TYPES = ["Green","White","Yellow","Oolong","Black","Dark","Pu-erh","Scented","Herbal","Other"]`
  - `GRADES = ["Everyday","Standard","Premium","Competition","Imperial / Gong Ting"]`
  - `RARITY = ["Common","Uncommon","Rare","Very rare"]`
- **Photo label scan:** user uploads/takes a photo of tea packaging; the app normalises the image
  (canvas re-encode to a bounded JPEG, max ~1600px, quality ~0.85), converts to base64, and calls
  `POST /api/scan`. The system prompt (`SCAN_SYSTEM`) instructs Anthropic to return ONLY a JSON
  object with keys `englishName, chineseName, type, flavourNotes, brewTemp, steepTime, origin,
  harvestYear, rarity, grade, reasoning`; translate Chinese; constrain `type` to the list above;
  `brewTemp` a Celsius number-as-string; `rarity`/`grade` from the lists; empty string when unknown.
  Parse the JSON out of the returned text tolerantly (balanced-brace extraction; ignore prose/fences).
- **Import / Export** JSON. Export downloads `{app,version,exportedAt,teas}`. Import accepts that
  shape or a bare array. Import must **match by `id` and update in place**, only assigning a new
  unique id to genuinely new entries. Use a collision-proof id generator
  (timestamp + counter + random), never a bare `Date.now()` inside a loop. Show a toast like
  "Import complete — X added, Y updated".
- **Dedupe** button (shown when >1 tea): collapse entries sharing the same `id`, else the same
  english+chinese name, keeping the richer record; toast how many were removed.
- **Caffeine context** section in the detail modal: a static horizontal bar chart comparing the
  selected tea's caffeine (parsed from its `caffeine` string like `~30 mg`, or midpoint of a range,
  or 0 for "caffeine-free") against typical drinks (herbal 0, decaf 3, green tea 28, cola 34,
  black tea 47, espresso 63, energy drink 80, brewed coffee 95 mg). Highlight the tea's bar.
- Persistence via the backend API as described above; `localStorage` only as an offline mirror.
- Tasteful, calm visual design (warm paper/ink palette). No backend framework leaking into UI.

### Frontend build/serve files
- `vite.config.js`: React plugin; dev server proxy `"/api" -> "http://localhost:8080"`.
- `nginx.conf`: `client_max_body_size 15m;`; `location /api/ { proxy_pass http://backend:8080; ... }`;
  SPA fallback `try_files $uri $uri/ /index.html;`.
- `frontend/Dockerfile`: stage 1 `node:20-slim` → `npm install` → `npm run build`; stage 2
  `nginx:1.27-alpine`, copy `nginx.conf` to `/etc/nginx/conf.d/default.conf` and `dist` to
  `/usr/share/nginx/html`.
- `frontend/package.json` deps: `react`, `react-dom`, `lucide-react`; dev: `vite`,
  `@vitejs/plugin-react`; scripts `dev/build/preview`.

---

## 6. Local dev — `docker-compose.yml`

Two services:
- `backend`: build `./backend`; env `PORT=8080`, `DATA_DIR=/app/data`,
  `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}`, `ANTHROPIC_MODEL=claude-sonnet-4-6`;
  named volume `tea-data:/app/data`; expose `8080:8080`.
- `frontend`: build `./frontend`; `depends_on: [backend]`; ports `8081:80`.
Named volume `tea-data`. (nginx proxies `/api` to the `backend` service by name.)

---

## 7. Kubernetes manifests (`k8s/`, namespace `tea-cabinet`)

- **00-namespace.yaml** — Namespace `tea-cabinet`.
- **10-pvc.yaml** — PVC `tea-data`, `ReadWriteOnce`, `storageClassName: local-path`, 1Gi.
  Comment that k3s provisions local-path on one node, hence the single backend replica.
- **20-backend-secret.example.yaml** — example `Secret` `tea-secrets` with `ANTHROPIC_API_KEY: REPLACE_ME`
  (stringData). Comment that the real file is gitignored and can instead be created with
  `kubectl create secret generic tea-secrets --from-literal=...`.
- **30-backend.yaml** — Deployment `backend`, **replicas: 1**, `strategy: Recreate` (single writer on
  the RWO volume). Image `ghcr.io/yanbin-pan/tea-cabinet-backend:latest`. Env `PORT`, `DATA_DIR=/app/data`,
  `ANTHROPIC_MODEL`, and `ANTHROPIC_API_KEY` from the `tea-secrets` secret. Mount PVC `tea-data` at
  `/app/data`. `readinessProbe` GET `/api/health` on 8080. Modest resource requests/limits
  (req 50m/64Mi, lim 500m/256Mi). Plus a `Service` `backend` on port 8080.
- **40-frontend.yaml** — Deployment `frontend`, replicas 2 (stateless), image
  `ghcr.io/yanbin-pan/tea-cabinet-frontend:latest`, readiness GET `/` on 80, small resources.
  Plus a `Service` `frontend` on port 80.
- **50-ingress.yaml** — Traefik `Ingress` (annotation
  `traefik.ingress.kubernetes.io/router.entrypoints: web`), host `tea.example.com`, path `/api` → backend:8080,
  path `/` → frontend:80. Comment that k3s bundles Traefik so no install is needed, and to change the host.

Make the GHCR owner substitutable, but write the files with `yanbin-pan` already in place so
`kubectl apply -f k8s/` works after only setting the secret and the host.

---

## 8. CI — `.github/workflows/ci.yaml`

- Trigger on push to `main` and `workflow_dispatch`.
- One job, `permissions: { contents: read, packages: write }`, matrix over `component: [backend, frontend]`.
- Steps: checkout; compute lowercase image name `ghcr.io/${owner,,}/tea-cabinet-${component}`;
  `docker/setup-qemu-action` (arm64 emulation); `docker/setup-buildx-action`;
  `docker/login-action` to `ghcr.io` using `github.actor` + `secrets.GITHUB_TOKEN`;
  `docker/build-push-action` with `context: ./${component}`, `platforms: linux/arm64`, `push: true`,
  tags `:latest` and `:${{ github.sha }}`, with GHA build cache.
- No extra secrets required (uses built-in `GITHUB_TOKEN`).

---

## 9. Supporting files

- **.gitignore**: `node_modules/`, `dist/`, `*.log`, `.env`, `.DS_Store`, `k8s/20-backend-secret.yaml`
  (the real secret), `backend/data/`.
- **backend/.dockerignore** & **frontend/.dockerignore**: `node_modules`, `dist`, `.env`, `*.log`
  (backend also `data`).
- **README.md**: what it is; architecture (frontend/backend/JSON persistence/scan proxy); local dev
  (both `npm run dev` and `docker compose up`); how CI pushes arm64 images to GHCR and the note to
  make the packages public or add a pull secret; k3s deploy steps (`create namespace`, create
  `tea-secrets`, set image owner + ingress host, `kubectl apply -f k8s/`); a note on Cloudflare Tunnel
  vs DNS+port-forward for exposure; how to back up the JSON with
  `kubectl -n tea-cabinet exec deploy/backend -- cat /app/data/collection.json > backup.json`.

---

## 10. Build, verify, and finish (do all of this)

1. Create every file above.
2. `cd backend && npm install` — confirm it installs.
3. `npm run test` in `backend` — all tests pass.
4. `cd ../frontend && npm install && npm run build` — confirm a clean production build (fix any
   real errors; do not silence them).
5. Optionally, if Docker is available: `docker compose build` to confirm both images build.
   (arm64 cross-build isn't required locally; CI handles the Pi target.)
6. `git add -A && git commit -m "Dockerised Tea Cabinet: backend API, frontend, k8s manifests, CI"`.
   Do not push; leave that to me.
7. Print a short summary: what was created, the test/build results, and a **"before you deploy"**
   checklist — (a) set the `tea-secrets` Anthropic key, (b) confirm the GHCR owner in the two
   deployment manifests, (c) set the ingress host to my Cloudflare domain, (d) after first CI run,
   make the GHCR packages pullable by the cluster.

## Acceptance criteria
- `npm run build` (frontend) and `npm run test` (backend) both succeed.
- No Anthropic API key is referenced anywhere in `frontend/`.
- `grep -R "window.storage" frontend/` returns nothing.
- Backend writes are atomic (temp-file + rename); no `.tmp` remains after a write.
- `kubectl apply --dry-run=client -f k8s/` is valid (if kubectl is available).
- All images target `linux/arm64` in CI.
