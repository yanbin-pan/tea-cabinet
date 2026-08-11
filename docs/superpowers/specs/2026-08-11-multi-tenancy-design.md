# Multi-tenancy and durable storage — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented

Deployment-specific values — hostname, the allow-listed addresses, the identity
team domain and audience tag — are deliberately absent from this public
repository. They live with the infrastructure configuration.

---

## Problem

Two problems, one of which causes the other to matter more.

**1. Saving fails silently and loses data.** Each tea embeds its packet photo as
a base64 data URL, and every save `PUT`s the whole collection. Measured against a
running instance: 14MB succeeds, 16MB returns `413`, because the API sets a 15MB
body limit. At roughly 25–50 teas, or a single import of a file that size, writes
begin to fail.

The failure is invisible. `persist()` wraps its `fetch` in `try/catch` with an
empty handler, and `fetch` does not reject on a `413` — it resolves with
`res.ok === false`, which nothing inspects. The import handler then reports
"Import complete" unconditionally. Data reaches React state and renders, never
reaches the server, and is gone on the next load. The `localStorage` mirror does
not help: browsers cap it near 5MB and `setItem` throws, into another empty
handler.

**2. There is one collection for everyone.** The app is single-tenant. Sharing
the link means sharing one cabinet.

### Contributing defects found while investigating

- `persist()` is called *inside* `setCollection` updater functions. Updaters must
  be pure, and `StrictMode` double-invokes them, so every save issues two `PUT`s.
- Both API replicas write the same temp path, `collection.json.tmp`, in a shared
  directory. Two concurrent saves can interleave and clobber one another.
- `hydrate()` returns `null` both when the server is unreachable and when it
  answers with an error, and the caller then substitutes seed data. "Server
  unreachable" and "server says empty" are indistinguishable to the user.

---

## Goals

- Each person gets a private collection, isolated from the others.
- A save either succeeds or reports a specific, visible failure. Never both.
- Collection size stops being bounded by an HTTP body limit.
- No authentication code in the application.

### Non-goals

- Sharing collections between people, or any concept of an administrator.
- Per-user quotas on label scanning. Scans bill to a single shared API key; this
  is a known, accepted cost risk.
- Offline editing. The local mirror stays read-only fallback, nothing more.

---

## Identity

Authentication is delegated entirely to an identity-aware proxy in front of the
app (Cloudflare Access). It authenticates the visitor and forwards two headers:

| Header | Purpose |
| --- | --- |
| `Cf-Access-Authenticated-User-Email` | convenience, **not trusted** |
| `Cf-Access-Jwt-Assertion` | signed token, **the only trusted source** |

The API verifies the JWT on every request:

1. Fetch the proxy's public keys (JWKS) from the team's certificate endpoint,
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
2. Select the key whose `kid` matches the token header, and verify the RS256
   signature against it. Matching on `kid` rather than trying each key is what
   makes key rotation a non-event.
3. Check `iss` equals `https://<team>.cloudflareaccess.com`, `aud` matches the
   configured application audience, and the token has not expired.
4. Take the identity from the verified `email` claim, lowercased.

Validating `iss` is not optional. Without it a correctly signed token issued for
a *different* team domain would be accepted, which is exactly the confused-deputy
case JWT verification is supposed to prevent.

Keys are cached in memory and refreshed periodically; an unknown `kid` or a
verification failure triggers one refresh and retry before rejecting.

**The API fails closed.** No token, an invalid signature, a wrong audience or an
expired token all return `401` with no body. This matters beyond correctness: the
data is unreachable even if the proxy configuration is later broken or removed,
so identity does not depend on ingress configuration staying correct.

The email header is never read. It is spoofable by anything that can reach the
API directly; the JWT is not.

New configuration, neither of which is a secret:

| Variable | Purpose |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | where to fetch the JWKS from |
| `ACCESS_AUD` | expected audience tag |

If either is unset the API refuses to start, rather than starting in a state
where it cannot authenticate anyone.

### Consequences

- HTTP basic auth is removed for this hostname; two prompts for one login is a
  poor trade. The rate limiter stays.
- The static shell (HTML, JS) becomes publicly readable. It contains no data.

---

## Storage

```
/app/data/users/<userKey>/
    collection.json          metadata only, a few KB
    photos/<photoId>.jpg     one file per photo
```

`userKey` is `sha256(lowercased email)` rendered as hex. Deriving the directory
name from a hash rather than the address itself removes path traversal and
character-escaping concerns by construction — no input reaches the filesystem.

`collection.json` holds `{ app, version, email, teas }`. The email is stored for
legibility when inspecting files by hand; the hash is what addresses them.

A tea's `photo` field changes from an inline data URL to a photo id.

### Photo endpoints

| Method | Path | Behaviour |
| --- | --- | --- |
| `POST` | `/api/photos` | Raw image bytes, `Content-Type: image/*`. Returns `{ id }`. |
| `GET` | `/api/photos/:id` | Serves the bytes. `Cache-Control: private, max-age=31536000, immutable`. |

Bytes are posted raw rather than base64-encoded, which removes the 33% encoding
overhead that helped cause the original problem.

`GET` resolves the path from the **caller's own** `userKey`, so one person cannot
read another's photo even knowing its id. Ids are random, not sequential.

Limits: 8MB per photo, 10MB request body for the photo route, 5MB for the
collection route — the latter now holds only metadata, so it is generous.

### Orphan cleanup

On each collection save, photo files not referenced by any tea are deleted —
**but only if older than 24 hours**. Without that guard, a photo uploaded seconds
earlier, whose tea has not yet been saved, would be deleted by a concurrent save
from another tab.

### Atomic writes

Writes stay "write temp, then rename", but the temp filename gains a unique
suffix per write. Rename remains atomic; the shared-path collision goes away.
Per-user files also mean two people saving at once no longer contend at all.

---

## Client changes

**`persist()` reports failure.** It checks `res.ok`, throws with a specific
message otherwise, and no longer swallows exceptions. Callers `await` it and show
a real error. Success messages appear only after the server confirms.

**Side effects leave the reducers.** `setCollection` updaters become pure; saving
happens after the state transition, fixing the `StrictMode` double-write.

**A save indicator.** Saving / saved / failed is visible, so a silent loss is not
possible even if an error toast is missed.

**`hydrate()` distinguishes failure modes.** Unreachable, unauthorised and empty
become three different outcomes with three different messages. An unreachable
server no longer silently presents seed data as if it were the collection.

**Import uploads photos first.** Inline data URLs in an imported file are
detected, uploaded individually, and replaced with ids; then the small metadata
document is saved. A large import becomes many small requests, none near any
limit. Progress is reported, and a failure part-way names what did not import.

---

## Migration

The server-side collection is empty, so there is no server data to migrate — a
consequence of the bug, since imports were never persisted.

Existing exported files remain importable. The import path detects inline photo
data URLs and converts them, so a file produced by the current version works
without modification.

---

## Testing

Backend, using a locally generated RSA key pair so no test touches the network:

- A correctly signed token authenticates; expired, wrong-audience, wrong-key,
  malformed and absent tokens each return `401`.
- Missing configuration prevents startup.
- **Isolation:** two identities write collections and photos; neither can read
  nor overwrite the other's, including by guessing a photo id.
- Photo round-trip: upload, fetch, correct content type, correct bytes.
- Orphan cleanup removes an unreferenced old photo and spares a recent one.
- Concurrent saves to one collection leave a valid file, with no temp file left.

Frontend:

- A `413` or `500` from a save surfaces an error and does **not** report success.
- Import of a file with inline photos produces the right ids and count.

CI keeps its existing manifest and secret assertions.

---

## Deployment

- Add the hostname to the identity proxy's application and policy, listing the
  permitted addresses (infrastructure repository).
- Remove the basic-auth middleware from the ingress; keep the rate limiter.
- Add `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to the deployment.
- Raise the volume request from 1Gi to 5Gi. **This is documentation, not
  enforcement.** The NFS provisioner never applies a quota — a pod sees the whole
  110G filesystem regardless of what the claim asks for. The number is raised so
  the manifest states the intended footprint honestly; the controls that actually
  bound this app's disk use are the per-photo limit and the collection size cap
  above. Capacity is watched cluster-wide by the existing filesystem alert.

## Risks

| Risk | Mitigation |
| --- | --- |
| Scanning costs are unbounded and shared | Accepted deliberately. Revisit with a per-user cap if it becomes real. |
| JWKS endpoint unreachable at startup | Cached keys; verification failures retry once after a refresh. Startup does not block on it. |
| A future change drops the ingress auth | The API fails closed on its own, so data stays protected. |
| Photos fill the volume | 5Gi with per-photo limits; monitored like any other volume. |
