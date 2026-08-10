# The Tea Cabinet

A personal inventory of Chinese tea — self-hosted. Photograph a tea packet and the
app translates the label, fills in type, origin, brewing guidance, grade and rarity,
and files it in your cabinet. Everything lives on your own hardware.

![type: k3s](https://img.shields.io/badge/deploy-k3s%20%2F%20arm64-4A5D3A) ![no database](https://img.shields.io/badge/storage-JSON%20file-8A5A3C)

---

## Architecture

Two containers, one JSON file.

```
browser ──► frontend (nginx, static React build)
                │  /api/*  proxied
                ▼
            backend (Node 20 + Express)
                │
                ├── /app/data/collection.json   ← the whole database
                └── api.anthropic.com           ← label scanning, key stays here
```

- **frontend/** — React 18 + Vite 5, `lucide-react` icons. Built to static files and
  served by nginx, which also proxies `/api` to the backend.
- **backend/** — Express 4 (ES modules). Two jobs: persist the collection to a JSON
  file, and proxy label scans to Anthropic.
- **Persistence** — a single `collection.json` on a mounted volume. Writes are
  **atomic** (temp file + `rename`), so a crash mid-save can never leave a torn file.
  The frontend owns all merge / dedupe / ID logic and `PUT`s the authoritative list;
  the server just stores what it is given. `localStorage` is kept as an offline mirror
  only — the backend is always the source of truth when reachable.
- **Scan proxy** — the browser never sees the Anthropic API key. It posts the image
  bytes to `POST /api/scan`; the backend adds the key server-side. With no key
  configured the endpoint answers `503` and the UI simply asks you to type the fields
  in by hand.

### API

| Method | Path              | Behaviour                                                        |
| ------ | ----------------- | ---------------------------------------------------------------- |
| `GET`  | `/api/health`     | `{ ok: true }` — used by the readiness probe.                     |
| `GET`  | `/api/collection` | `{ teas: [...] }`.                                                |
| `PUT`  | `/api/collection` | Accepts `{teas:[...]}` or a bare array. Returns `{ok:true,count}`.|
| `POST` | `/api/scan`       | `{mediaType,b64,system}` → `{text}`. `503` if no key is set.       |

Backend environment: `PORT` (8080), `DATA_DIR` (`./data`), `ANTHROPIC_API_KEY` (empty),
`ANTHROPIC_MODEL` (`claude-sonnet-4-6`).

---

## Local development

### Node, two terminals

```bash
cd backend && npm install && npm run dev      # :8080
cd frontend && npm install && npm run dev     # :5173, proxies /api to :8080
```

Set `ANTHROPIC_API_KEY` in the backend terminal to exercise label scanning.

### Docker Compose

```bash
ANTHROPIC_API_KEY=sk-ant-... docker compose up --build
```

Frontend on <http://localhost:8081>, backend on <http://localhost:8080>. Data persists
in the `tea-data` named volume.

### Tests

```bash
cd backend && npm test        # node:test — persistence + routes, no network needed
cd frontend && npm run build  # a real production build is the frontend's gate
```

---

## CI/CD

`.github/workflows/verify.yaml` runs on every branch and pull request: backend tests,
a production frontend build, and a guard asserting no Anthropic credentials or Claude
artifact globals ever land in `frontend/`.

`.github/workflows/ci.yaml` runs on push to `main` (or manually via *Run workflow*).
It cross-builds both images for **linux/arm64** with QEMU + Buildx and pushes them to
GHCR as:

- `ghcr.io/yanbin-pan/tea-cabinet-backend:latest` and `:<sha>`
- `ghcr.io/yanbin-pan/tea-cabinet-frontend:latest` and `:<sha>`

No extra secrets are needed — it authenticates with the built-in `GITHUB_TOKEN`.

> **After the first successful run**, make the two GHCR packages pullable by the
> cluster. Either set each package to **public** (GitHub → your profile → Packages →
> package → Package settings → Change visibility), or keep them private and give the
> cluster a pull secret:
>
> ```bash
> kubectl -n tea-cabinet create secret docker-registry ghcr-pull \
>   --docker-server=ghcr.io --docker-username=yanbin-pan --docker-password=<PAT with read:packages>
> ```
>
> then add `imagePullSecrets: [{name: ghcr-pull}]` to both pod specs.

---

## Deploying to k3s

The manifests in `k8s/` target k3s specifically: it bundles **Traefik** as the ingress
controller and the **local-path** storage provisioner, so nothing else needs installing.

```bash
kubectl apply -f k8s/00-namespace.yaml

# The Anthropic key. Skip this and everything still runs — scanning just returns 503.
kubectl -n tea-cabinet create secret generic tea-secrets \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-...

# Set your own host in k8s/50-ingress.yaml (default placeholder: tea.example.com),
# and confirm the GHCR owner in k8s/30-backend.yaml and k8s/40-frontend.yaml.

kubectl apply -f k8s/
kubectl -n tea-cabinet rollout status deploy/backend deploy/frontend
```

Notes:

- `local-path` binds the volume to whichever node the pod lands on, so the claim is
  `ReadWriteOnce` and the backend runs **one replica with a `Recreate` strategy** —
  a single writer over that file. The frontend is stateless and runs two replicas.
- The `ANTHROPIC_API_KEY` env reference is marked `optional: true`, so the backend
  starts cleanly on a cluster where the secret hasn't been created yet.
- Rolling a new image after CI: `kubectl -n tea-cabinet rollout restart deploy/backend deploy/frontend`
  (both use `imagePullPolicy: Always` with the `:latest` tag), or pin the `:<sha>` tag
  for a reproducible deploy.

### Exposing it

- **Cloudflare Tunnel (recommended)** — run `cloudflared` in the cluster or on the Pi
  pointing at the `frontend` service or the Traefik ingress. No ports opened on your
  router, no dynamic-DNS worries, and TLS terminates at Cloudflare. This is the safer
  option for a home network.
- **DNS + port-forward** — point an A record at your home IP and forward 80/443 to the
  Pi. Simpler conceptually, but it exposes your home address and needs your own TLS
  (add cert-manager or a Traefik ACME resolver, and switch the ingress entrypoint to
  `websecure`).

### Backups

The whole database is one file:

```bash
kubectl -n tea-cabinet exec deploy/backend -- cat /app/data/collection.json > backup.json
```

Restore by importing that file through the app's **Import** button, which matches
entries by `id` and updates in place.

---

## Repository layout

```
frontend/   React + Vite app, nginx serving config, Dockerfile
backend/    Express API, node:test suite, Dockerfile
k8s/        namespace, PVC, secret example, deployments, Traefik ingress
.github/    verify (tests) and ci (arm64 build + GHCR push) workflows
reference/  the original single-file UI artifact and the build spec
```
