// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Downloads the latest GenieX CLI release installer, verifies its SHA-256, and
// launches it interactively. Windows ARM64 only; Linux still uses install.sh.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RELEASES = "https://github.com/qualcomm/GenieX/releases";

function fail(message) {
  console.error(`geniex:install: ${message}`);
  process.exit(1);
}

if (process.platform !== "win32" || process.arch !== "arm64") {
  fail(
    `this installer supports Windows ARM64 only (this is ${process.platform}-${process.arch}). ` +
      `See ${RELEASES} for other platforms.`,
  );
}

// /releases/latest redirects to /releases/tag/<tag>; reading the redirect avoids
// the rate-limited GitHub API.
const latest = await fetch(`${RELEASES}/latest`, { redirect: "manual" });
const tag = latest.headers.get("location")?.split("/tag/")[1];
if (!tag) {
  fail(`could not resolve the latest release from ${RELEASES}/latest.`);
}

const asset = `geniex-cli-setup-windows-arm64-${tag}.exe`;
const base = `${RELEASES}/download/${tag}/${asset}`;

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    fail(`download failed (${res.status}): ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

console.log(`Downloading ${asset} ...`);
const [exe, sha] = await Promise.all([download(base), download(`${base}.sha256`)]);

const expected = sha.toString("utf8").trim().split(/\s+/)[0].toLowerCase();
const actual = createHash("sha256").update(exe).digest("hex");
if (actual !== expected) {
  fail(`SHA-256 mismatch for ${asset} (expected ${expected}, got ${actual}).`);
}

const installer = path.join(mkdtempSync(path.join(tmpdir(), "geniex-")), asset);
writeFileSync(installer, exe);

console.log("Checksum OK. Launching the installer — follow its prompts.");
const result = spawnSync(installer, { stdio: "inherit" });
if (result.error || result.status !== 0) {
  fail(`installer did not complete successfully (${result.error?.message ?? result.status}).`);
}
console.log("Done. Restart the gateway so it picks up the updated PATH.");
