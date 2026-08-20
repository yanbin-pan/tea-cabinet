import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The app is a Chinese tea collection, so a meaningful share of its visitors
// are behind the Great Firewall. Google's font hosts are blocked there, and a
// blocked stylesheet is not a fast failure: the connect hangs on a poisoned DNS
// answer, and a pending @import blocks rendering, so a remote font turns into a
// blank page for exactly the audience the app is for.
//
// That regressed once, silently, because nothing in the suite looked. These
// tests read the source tree as text rather than importing it — App.jsx is JSX
// against React and the suite runs in a bare node environment, and text is the
// right altitude anyway: the question is what the built page will ask the
// network for, not what any module exports.

const SRC = dirname(fileURLToPath(import.meta.url));
const FRONTEND = dirname(SRC);

// This file necessarily spells out the hosts it forbids, so scanning it would
// always match. It is the only exemption.
const SELF = "fonts.test.js";

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(jsx?|css|html)$/.test(entry) && entry !== SELF) out.push(full);
    }
  };
  walk(SRC);
  out.push(join(FRONTEND, "index.html"));
  return out;
}

const files = sourceFiles().map((path) => ({
  path: relative(FRONTEND, path),
  text: readFileSync(path, "utf8"),
}));

// Matches a real reference, not prose: the host has to appear inside a URL with
// a scheme, which is how it would be fetched and is not how a comment mentions
// it. Keeps the guard from firing on the note explaining why it exists.
const BLOCKED_HOSTS = /https?:\/\/(?:[a-z0-9-]+\.)*(?:googleapis|gstatic|typekit|fontawesome|bunny\.net)\.?[a-z]*\//gi;

describe("fonts are served from our own origin", () => {
  test("no source file references a font host that mainland China blocks", () => {
    const offenders = files
      .flatMap(({ path, text }) => (text.match(BLOCKED_HOSTS) ?? []).map((url) => `${path}: ${url}`));
    expect(offenders).toEqual([]);
  });

  test("no stylesheet is pulled in over the network", () => {
    // Covers both spellings the regression could take: a CSS @import, and a
    // <link rel="stylesheet"> in the HTML shell.
    const remoteImport = /@import\s+url\(\s*['"]?\s*https?:/i;
    const remoteLink = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']\s*https?:/i;

    const offenders = files
      .filter(({ text }) => remoteImport.test(text) || remoteLink.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  test("the Chinese display stack ends in a generic family", () => {
    // Whatever names sit in front, the stack has to bottom out somewhere the
    // device can satisfy locally — otherwise a future edit reintroduces a
    // download-or-nothing face without tripping the tests above.
    const app = files.find(({ path }) => path.endsWith("App.jsx")).text;
    const hanzi = app.match(/^const HANZI = "(.+)";$/m);

    expect(hanzi, "App.jsx no longer defines HANZI").not.toBeNull();
    expect(hanzi[1].split(",").pop().trim()).toBe("serif");
  });
});
