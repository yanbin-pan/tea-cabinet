import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { accessConfig, createVerifier, requireAccess } from "../lib/auth.js";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";

// A local key pair keeps these tests entirely offline.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
const jwks = createLocalJWKSet({ keys: [jwk] });
const verify = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks });

function token(claims = {}, { issuer = ISSUER, audience = AUDIENCE, expiry = "5m" } = {}) {
  return new SignJWT({ email: "person@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(privateKey);
}

test("a correctly signed token yields the email, lowercased", async () => {
  assert.equal(await verify(await token({ email: "Person@Example.COM" })), "person@example.com");
});

test("a token from a different issuer is rejected", async () => {
  await assert.rejects(async () => verify(await token({}, { issuer: "https://evil.cloudflareaccess.com" })));
});

test("a token for a different audience is rejected", async () => {
  await assert.rejects(async () => verify(await token({}, { audience: "someone-elses-app" })));
});

test("an expired token is rejected", async () => {
  await assert.rejects(async () => verify(await token({}, { expiry: "-1m" })));
});

test("a token signed by an unknown key is rejected", async () => {
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT({ email: "person@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("5m")
    .sign(other.privateKey);
  await assert.rejects(() => verify(forged));
});

test("a malformed token is rejected", async () => {
  await assert.rejects(() => verify("not.a.token"));
});

test("a valid token carrying no email is rejected", async () => {
  const t = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("5m")
    .sign(privateKey);
  await assert.rejects(() => verify(t));
});

test("accessConfig refuses to build without both variables", () => {
  assert.throws(() => accessConfig({}));
  assert.throws(() => accessConfig({ ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com" }));
  assert.throws(() => accessConfig({ ACCESS_AUD: "tag" }));

  const cfg = accessConfig({ ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "tag" });
  assert.equal(cfg.issuer, ISSUER);
  assert.equal(cfg.audience, "tag");
  assert.equal(cfg.jwksUrl, `${ISSUER}/cdn-cgi/access/certs`);
});

test("requireAccess rejects a request with no token", async () => {
  const mw = requireAccess(verify);
  let status = 0;
  await mw(
    { get: () => undefined },
    { status(c) { status = c; return this; }, end() {} },
    () => assert.fail("next must not be called")
  );
  assert.equal(status, 401);
});

// The email header is attacker-controlled inside the cluster; only the signed
// assertion may establish identity.
test("requireAccess ignores the email header entirely", async () => {
  const mw = requireAccess(verify);
  let status = 0;
  await mw(
    { get: (h) => (h.toLowerCase() === "cf-access-authenticated-user-email" ? "admin@example.com" : undefined) },
    { status(c) { status = c; return this; }, end() {} },
    () => assert.fail("next must not be called")
  );
  assert.equal(status, 401);
});

test("requireAccess attaches the verified email and continues", async () => {
  const mw = requireAccess(verify);
  const t = await token();
  const req = { get: (h) => (h.toLowerCase() === "cf-access-jwt-assertion" ? t : undefined) };
  let called = false;
  await mw(req, { status() { return this; }, end() {} }, () => { called = true; });
  assert.ok(called);
  assert.equal(req.userEmail, "person@example.com");
});
