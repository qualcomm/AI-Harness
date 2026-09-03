// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Shared artifact directory — the side channel for hand-off payloads too large
 * for the prior-context budget.
 *
 * WHY THIS EXISTS
 *
 * Only a worker's final assistant message crosses to a downstream subtask, capped
 * at `maxContextChars` (see pipeline.ts `buildHandoffNotice`). The escape hatch used
 * to be prose guidance telling workers to "write the rest to a workspace file and
 * name the file in the reply" — which could not work: relative paths resolve against
 * each agent's OWN workspace subdirectory, so a bare filename written by `research`
 * lands in `workspace/research/` while a consumer resolves it under
 * `workspace/writing/`. Measured in the 2026-08-31 00:48 run: `research` wrote a
 * 2707-byte file, `writing` read `writing/hexicorridor_tourism.md`, got ENOENT
 * against `...\workspace\writing\writing\hexicorridor_tourism.md` (the model's own
 * `writing/` prefix stacked on top of the cwd), spent 13 exec calls hunting for it,
 * then silently rewrote the content from the truncated summary. The subtask still
 * reported ok.
 *
 * A handle that cannot be dereferenced is worse than no handle: the model trusts it
 * and burns turns. So this module supplies one that resolves from ANY agent's cwd.
 *
 * DESIGN
 *
 * - Rooted at `stateDir`, which the plugin already owns (see pipeline-store.ts) —
 *   NOT at an agent workspace, since every one of those is per-agent by definition.
 * - Paths handed to workers are ABSOLUTE. That is what sidesteps the whole problem:
 *   `SubagentRunParams` has no cwd slot (see runtime-contract.ts), so the plugin
 *   cannot place two agents in one directory — but an absolute path does not care
 *   which directory the agent is standing in.
 * - One directory PER SUBTASK, not one per pipeline. Subtasks within a layer run
 *   concurrently, and a single shared directory would make concurrent writers race
 *   over filenames. One writer per directory removes that class of bug outright
 *   ("writes stay single-threaded", the rule Cognition landed on).
 * - Contents are DISCOVERED BY SCANNING, never taken from the worker's word. A
 *   worker that claims a file it did not write produces an empty list, which is what
 *   makes the mismatch detectable (see `detectUnresolvedFileClaims`) instead of
 *   silently believed.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "./runtime-contract.js";
import type { SubtaskArtifact } from "./types.js";

/** Directory name under `stateDir`. */
const ARTIFACT_DIR_NAME = "artifacts";

/**
 * Hash length for the per-pipeline segment. Same 128-bit budget as session-key.ts,
 * for the same reason: enough to not collide at this volume.
 */
const DIGEST_HEX_LENGTH = 32;

/**
 * Cap on files reported per subtask. A runaway worker writing thousands of files
 * must not turn the hand-off notice into an unbounded listing.
 */
const MAX_ARTIFACTS_PER_SUBTASK = 20;

/** Cap on how deep the scan walks. Workers may create a subdirectory; nesting beyond that is noise. */
const MAX_SCAN_DEPTH = 2;

/**
 * Set once from the plugin's service `start`, the only place `stateDir` is
 * available. Left null in tests and when the service never started — every
 * function below degrades to "no artifact channel" rather than throwing, so the
 * pipeline runs exactly as it did before this module existed.
 */
let artifactRoot: string | null = null;

/** Initialize from the service context. Safe to call more than once. */
export function initArtifactRoot(stateDir: string): void {
  artifactRoot = path.join(stateDir, ARTIFACT_DIR_NAME);
}

/** Test hook: forget the root so a suite can assert the degraded path. */
export function resetArtifactRoot(): void {
  artifactRoot = null;
}

/** Whether the artifact channel is available at all. */
export function artifactChannelReady(): boolean {
  return artifactRoot !== null;
}

/**
 * Absolute directory for one subtask's artifacts, or null when uninitialized.
 *
 * Keyed by a hash of the root session so two concurrent requests cannot write into
 * each other's directory, and by subtask id so siblings in a layer cannot either.
 */
export function artifactDirFor(rootSessionKey: string, subtaskId: number): string | null {
  if (!artifactRoot) return null;
  const digest = createHash("sha256")
    .update(rootSessionKey)
    .digest("hex")
    .slice(0, DIGEST_HEX_LENGTH);
  return path.join(artifactRoot, digest, `subtask-${subtaskId}`);
}

/**
 * Create the directory for a subtask about to run, returning its absolute path.
 *
 * Returns null on any failure: a worker that cannot be given a writable directory
 * simply does not get the file route, and the reply-text route still works. This
 * must never fail the subtask.
 */
export function ensureArtifactDir(
  rootSessionKey: string,
  subtaskId: number,
  logger?: Logger,
): string | null {
  const dir = artifactDirFor(rootSessionKey, subtaskId);
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    logger?.warn(
      `[dragon-task-orchestrator] could not create artifact dir for subtask ${subtaskId}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Scan a subtask's directory and report what is actually there.
 *
 * Sorted by name so the listing is stable across runs (readdir order is not
 * guaranteed), and capped. Unreadable entries are skipped rather than aborting the
 * scan: one bad file must not hide the others.
 */
export function listArtifacts(dir: string | null): SubtaskArtifact[] {
  if (!dir) return [];
  const found: SubtaskArtifact[] = [];

  const walk = (current: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_ARTIFACTS_PER_SUBTASK) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // Never created, or unreadable — same outcome as empty.
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_ARTIFACTS_PER_SUBTASK) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(full).size;
      } catch {
        continue; // Vanished between readdir and stat.
      }
      found.push({ name: path.relative(dir, full), uri: full, bytes });
    }
  };

  walk(dir, 1);
  return found;
}

/** Human-readable byte size for the prompt listing. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render a dependency's artifacts as an absolute-path listing for its consumer.
 *
 * Absolute paths are stated as such, and the consumer is told NOT to prefix them.
 * That second half is not decoration: the failure in the 2026-08-31 run was the
 * model helpfully adding a `writing/` prefix to a path that was already complete.
 */
export function describeArtifactsForConsumer(
  subtaskId: number,
  artifacts: SubtaskArtifact[],
): string {
  if (artifacts.length === 0) return "";
  const lines = artifacts.map((a) => `- ${a.uri}（${formatBytes(a.bytes)}）`);
  return [
    `子任务${subtaskId}还产出了以下文件，可用 read 工具按需读取完整内容：`,
    ...lines,
    "以上是完整的绝对路径，请原样使用，不要在前面拼接任何目录名。",
  ].join("\n");
}

/**
 * Tell a worker where it may write overflow output.
 *
 * Names the directory explicitly, unlike the guidance this replaces. Phrased as an
 * option rather than a requirement: a worker whose output already fits, or one
 * without filesystem tools, must not be pushed into failing.
 */
export function describeArtifactDirForWorker(dir: string): string {
  return [
    `如果完整产出明显超出上述长度，请把最重要的部分写在正文里，其余写入下面这个目录（这是给你准备的共享产物目录，后续子任务能直接读到）：`,
    dir,
    "写入时请使用该目录下的完整绝对路径，并在正文里说明你写了哪些文件、每个文件装的是什么。",
  ].join("\n");
}

/**
 * File-ish names a worker's reply claims to have produced.
 *
 * Deliberately narrow: a known-document extension preceded by a filename-shaped
 * run of characters. A broad pattern would match prose mentioning a format and
 * report false problems on every subtask that says the word "markdown".
 */
const FILE_CLAIM_PATTERN =
  /[\w\-.一-龥/\\]+\.(?:md|markdown|txt|csv|json|ya?ml|html?|xlsx?|pdf|docx?|tsv)\b/gi;

/**
 * URLs, stripped before claim matching.
 *
 * Without this, every cited source ending in `.html` — and research subtasks cite many —
 * would be read as a claimed local file and reported missing. A check that fires on normal
 * output gets ignored, which would cost the real signal.
 */
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/**
 * Names claimed in `text` that no real artifact accounts for.
 *
 * This is the visibility half of the fix. A worker that says "详见 foo.md" while its
 * artifact directory is empty has produced a dead handle — exactly the 2026-08-31
 * failure — and the pipeline used to report that subtask as a clean ok. Surfacing it
 * turns a silent data loss into something the operator and the verifier can see.
 *
 * Matching is on BASENAME, so a claim written with any directory prefix still
 * resolves against a real file of that name. The prefix being wrong is precisely the
 * mistake being tolerated here: the file exists and the consumer is handed its
 * absolute path anyway, so a prefix mismatch alone is not a problem worth reporting.
 */
export function detectUnresolvedFileClaims(
  text: string,
  artifacts: SubtaskArtifact[],
): string[] {
  const matches = text.replace(URL_PATTERN, " ").match(FILE_CLAIM_PATTERN);
  if (!matches) return [];
  const realNames = new Set(
    artifacts.map((a) => path.basename(a.name).toLowerCase()),
  );
  const unresolved = new Set<string>();
  for (const raw of matches) {
    const base = path.basename(raw.replaceAll("\\", "/")).toLowerCase();
    if (!realNames.has(base)) unresolved.add(raw);
  }
  return [...unresolved];
}
