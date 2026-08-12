import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access sends two headers. Only one of them is evidence.
const TOKEN_HEADER = "Cf-Access-Jwt-Assertion";

export function accessConfig(env = process.env) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (!team || !audience) {
    throw new Error(
      "ACCESS_TEAM_DOMAIN and ACCESS_AUD must both be set. Refusing to start: " +
      "without them no request can be authenticated and every user would be denied."
    );
  }
  const issuer = `https://${team}`;
  return { issuer, audience, jwksUrl: `${issuer}/cdn-cgi/access/certs` };
}

// ACCESS_TEST_JWKS lets tests substitute a local key set for Cloudflare's, so
// they can run signature verification offline. That is a change to *which
// key is trusted*, not just how it's checked — so it must be structurally
// impossible for it to take effect in production, where a stray env var
// (leftover from a misconfigured deploy, a copy-pasted manifest, etc.) could
// otherwise let an attacker-controlled key set replace Cloudflare's.
export function testJwksOverride(env = process.env) {
  if (env.NODE_ENV === "production") return null;
  return env.ACCESS_TEST_JWKS || null;
}

export function remoteJwks(jwksUrl) {
  // Handles caching, kid matching and refetching on an unknown kid, which is
  // what makes Cloudflare's key rotation a non-event here.
  return createRemoteJWKSet(new URL(jwksUrl));
}

export function createVerifier({ issuer, audience, jwks }) {
  return async function verify(token) {
    // jwtVerify checks the signature against the kid-matched key, and the
    // issuer, audience and expiry claims. Skipping issuer would accept a
    // correctly signed token minted for a different Access team.
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) throw new Error("The token carries no email claim.");
    return email;
  };
}

export function requireAccess(verify) {
  return async function accessMiddleware(req, res, next) {
    const token = req.get(TOKEN_HEADER);
    if (!token) {
      // Fail closed. No body: an unauthenticated caller learns nothing.
      res.status(401).end();
      return;
    }
    try {
      req.userEmail = await verify(token);
      next();
    } catch (e) {
      res.status(401).end();
    }
  };
}
