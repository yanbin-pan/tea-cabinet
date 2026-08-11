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

**Merge to `main` → tests → arm64 images → pinned tag → Flux deploys.** Live at
<https://tea.minipi.net> about two minutes later.

```
  PR ──► verify.yaml ──┐
                       │  tests · frontend build · kustomize build · secret guards
  merge to main ──► ci.yaml
                       │
                       ├─ build   cross-build linux/arm64, push to GHCR as :latest and :<sha>
                       │          then assert the pushed manifest really is arm64
                       │
                       └─ deploy  rewrite both newTag values in k8s/kustomization.yaml
                                  to <sha> and push that commit back to main
                                          │
                                          ▼
                          Flux (in-cluster) notices within ~1 min and reconciles
```

### Why the deploy step is a git commit, not `kubectl apply`

The cluster's API server is deliberately unreachable from the internet, so a GitHub
runner could not talk to it even holding credentials. Flux pulls instead of CI pushing.
Three things fall out of that:

- **No cluster credentials exist in GitHub at all** — nothing to leak or rotate.
- **A rollback is `git revert`.** The running image tag is a line in a file, in history.
- **The cluster is the source of truth for nothing.** Reconstructible from the repo.

`verify.yaml` is reused by `ci.yaml` via `workflow_call`, so nothing reaches GHCR that
has not passed the exact gate a pull request does.

> **The push-back could loop.** `ci.yaml` writes `k8s/kustomization.yaml`, and a push to
> `main` is what triggers it. The trigger's `paths-ignore` lists that file, so the bot's
> own commit cannot start another run. Do not remove it.

### Where the cluster is wired up

One file in the `home-cluster` repo, [`clusters/home/tea-cabinet.yaml`](https://github.com/yanbin-pan/home-cluster/blob/main/clusters/home/tea-cabinet.yaml),
points Flux at *this* repository's `k8s/` directory. That is the entire integration —
this app owns its own manifests, versioned next to the code they deploy, and no
cross-repo write credential is needed in either direction.

---

## Deploying to k3s

Routine deploys need nothing but a merge. The steps below are **first-time setup only**,
and the order matters.

**1. Create `main`.** Flux is told to watch that branch; it must exist first.

```bash
git push github HEAD:main
```

**2. Let CI build.** The first run publishes both GHCR packages. Until it finishes, the
manifests still point at `:latest`, which does not exist yet — expect `ImagePullBackOff`
in that window. It clears itself when the deploy job pins the SHA.

**3. Make the packages pullable.** New GHCR packages are private, and the cluster has no
credentials. Set both to **public** — GitHub → your profile → Packages →
`tea-cabinet-backend` / `tea-cabinet-frontend` → Package settings → Change visibility.

<details>
<summary>Or keep them private and give the cluster a pull secret</summary>

```bash
kubectl -n tea-cabinet create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=yanbin-pan --docker-password=<PAT with read:packages>
```

then add `imagePullSecrets: [{name: ghcr-pull}]` to both pod specs. Note this secret is
*not* in git, so it will not survive a cluster rebuild — the public route is one less
thing to remember.
</details>

**4. Point Flux at the repo**, from the `home-cluster` checkout:

```bash
git add clusters/home/tea-cabinet.yaml && git commit -m "Deploy the Tea Cabinet" && git push
```

**5. Watch it land.**

```bash
flux reconcile kustomization tea-cabinet --with-source
kubectl -n tea-cabinet rollout status deploy/backend deploy/frontend
curl -sS -o /dev/null -w '%{http_code}\n' https://tea.minipi.net/   # expect 401
```

A `401` is the correct answer — that is the basic-auth gate working.

### The Anthropic key (optional)

Without it the app runs fine; `/api/scan` answers `503` and the UI asks you to type the
fields in. To enable label scanning, add it the same way the login is stored — encrypted
in git, so it survives a rebuild:

```bash
cat > k8s/80-anthropic-secret.sops.yaml <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: tea-secrets
type: Opaque
stringData:
  ANTHROPIC_API_KEY: sk-ant-...
YAML
sops --encrypt --in-place k8s/80-anthropic-secret.sops.yaml
# add it to the `resources:` list in k8s/kustomization.yaml, then commit
```

The env reference is marked `optional: true`, so the backend starts cleanly either way.

### Notes on the manifests

- **Storage is `ssd`, not `local-path`.** The claim omits `storageClassName` to get the
  cluster default: an NFS export of rpi-01's SSD, backed up nightly to R2. `local-path`
  is one node's SD card with no backup.
- **`ReadWriteMany`, deliberately.** Both backend replicas mount the same volume, and
  they may land on different nodes. Verified on this cluster: two pods on `rpi-02` and
  `rpi-03` each saw the other's writes. This is safe *for this app* only because every
  write is a whole-file atomic rename — do not copy it for an app with a SQLite database.
- **Image tags are pinned to a SHA by CI**, so `imagePullPolicy` is left at the default.
  Pulling on every restart was only needed because `:latest` is mutable.
- **Concurrent edits are last-writer-wins.** Two browser tabs saving at once means one
  overwrites the other. That was already true with one replica — the frontend `PUT`s the
  whole authoritative list — and two replicas do not make it worse.
- **A frontend pod can crash-loop briefly on a first deploy.** nginx resolves the
  `backend` hostname in `proxy_pass` once at startup and exits if it does not resolve, so
  a frontend pod that starts before the `backend` Service exists will restart until it
  does. It is self-correcting and only shows up on the very first apply. Through the
  ingress this proxy is unused anyway — Traefik sends `/api` straight to the backend.

### Exposing it

Already handled by the cluster, with no change needed here. The Cloudflare tunnel routes
`*.minipi.net` to Traefik, and `k8s/50-ingress.yaml` is the per-app rule claiming
`tea.minipi.net`. No DNS record, no Terraform change, no open port on the router. TLS
terminates at Cloudflare's edge, which is why the ingress speaks plain HTTP.

### Who can get in

Traefik challenges with HTTP basic auth before a request reaches either service, so an
unauthenticated visitor gets a `401` and never touches the app. Credentials live in
`k8s/70-basic-auth-secret.sops.yaml` as a bcrypt htpasswd line, committed encrypted
against the cluster's age key and decrypted in-cluster by Flux.

Change the password:

```bash
htpasswd -nbB ybpan 'new-password'          # copy the output line
sops k8s/70-basic-auth-secret.sops.yaml     # paste it under `users:`, save
git commit -am "Rotate the Tea Cabinet password" && git push
```

Basic auth replays the password on every request and is visible to Cloudflare, which
terminates TLS. That is a reasonable trade for a personal app. To add a second,
independent layer that stops unauthenticated traffic *before* it reaches your house, add
`tea.minipi.net` to `terraform/cloudflare/access.tf` in the `home-cluster` repo and
`terraform apply` — the two stack, exactly as Grafana already does it.

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
k8s/        what Flux deploys — kustomization.yaml is the entry point
              00-namespace  10-pvc  30-backend  40-frontend
              50-ingress    60-basic-auth (Traefik middleware)
              70-basic-auth-secret.sops.yaml  ← encrypted, safe to commit
.github/    verify (tests + manifest render + secret guards)
            ci      (arm64 build → GHCR → pin tag → push back for Flux)
.sops.yaml  which age key secrets in this repo are encrypted to
reference/  the original single-file UI artifact and the build spec
```

Anything matching `*.sops.yaml` is encrypted at rest and checked by CI; the `secrets`
job fails the build if such a file is ever committed in the clear.
