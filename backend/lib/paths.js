import crypto from "node:crypto";
import path from "node:path";

// The directory name is a hash of the address, never the address itself. That
// removes path traversal and character-escaping concerns by construction: no
// byte the user controls is ever part of a filesystem path.
export function userKey(email) {
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("userKey requires an email address.");
  }
  const normalised = email.trim().toLowerCase();
  if (!normalised) throw new Error("userKey requires an email address.");
  return crypto.createHash("sha256").update(normalised).digest("hex");
}

export function userDir(dataDir, key) {
  return path.join(dataDir, "users", key);
}
