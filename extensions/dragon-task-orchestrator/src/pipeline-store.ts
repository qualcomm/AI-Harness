/**
 * Persistent store for user-defined fixed pipelines.
 *
 * WHY A FILE RATHER THAN `openclaw.json`
 * `config.patch` schedules a gateway restart on any real change
 * (`src/gateway/server-methods/config.ts`). Reordering steps by drag is a
 * high-frequency edit, so routing it through config would restart the gateway — and
 * drop every WebSocket connection — on every drag. Pipelines therefore live in the
 * plugin's own state directory, reachable over the plugin's own gateway methods.
 *
 * This is the opposite choice from `mission-mode.ts`, which deliberately does NOT
 * persist. The distinction is deliberate: a pipeline is a user asset that must survive
 * a restart, while "which mode is this session in" is session context that is safer to
 * lose than to resurrect stale.
 *
 * CONCURRENCY uses two independent mechanisms, and both are required:
 * - `revision` (optimistic lock) stops one editor silently overwriting another's work.
 * - a write chain (mutex) stops two concurrent writes from interleaving and producing a
 *   corrupt file. A revision check alone cannot prevent that, since both writers can
 *   pass the check before either writes.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "./runtime-contract.js";
import { INTERNAL_AGENT_IDS } from "./session-key.js";

export type PipelineStep = {
  agentId: string;
  /** What this step should do. Becomes the instruction block of the step's prompt. */
  instruction: string;
};

export type Pipeline = {
  /** Server-generated and immutable: sessions reference this, so renaming must not break them. */
  id: string;
  name: string;
  steps: PipelineStep[];
  createdAt: number;
  updatedAt: number;
};

type StoreFile = {
  version: number;
  revision: number;
  pipelines: Pipeline[];
};

export type PipelineSnapshot = { revision: number; pipelines: Pipeline[] };

/**
 * Why a validation failed, as data rather than prose.
 *
 * The Control UI is localized and this store is not: a translated sentence built here
 * could only ever be in one language. So the reason travels as a code plus its
 * parameters, and `message` carries English prose for logs and for any caller that has
 * no translation table.
 */
export type PipelineInvalidReason =
  | { code: "name_empty" }
  | { code: "name_too_long"; max: number }
  | { code: "no_steps" }
  | { code: "too_many_pipelines"; max: number }
  | { code: "too_many_steps"; max: number }
  | { code: "step_no_agent"; step: number }
  | { code: "step_internal_agent"; step: number; agentId: string }
  | { code: "step_unknown_agent"; step: number; agentId: string }
  | { code: "step_instruction_too_long"; step: number; max: number };

export type WriteResult =
  | ({ ok: true } & PipelineSnapshot)
  | ({
      ok: false;
      code: "conflict" | "not_found" | "invalid";
      message: string;
      /** Present only for `code: "invalid"`. */
      reason?: PipelineInvalidReason;
    } & PipelineSnapshot);

/** Bumped when the on-disk shape changes; a missing value is treated as 1. */
const SCHEMA_VERSION = 1;

export const MAX_PIPELINES = 50;
export const MAX_STEPS = 20;
export const MAX_NAME_CHARS = 60;
export const MAX_INSTRUCTION_CHARS = 2000;

const FILE_NAME = "pipelines.json";

let storePath: string | null = null;
let cache: StoreFile = { version: SCHEMA_VERSION, revision: 0, pipelines: [] };
let storeLogger: Logger | undefined;
/** Serializes writes; see the concurrency note in the module comment. */
let writeChain: Promise<unknown> = Promise.resolve();

function emptyFile(): StoreFile {
  return { version: SCHEMA_VERSION, revision: 0, pipelines: [] };
}

function isStep(value: unknown): value is PipelineStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.agentId === "string" && typeof record.instruction === "string";
}

/**
 * Parse defensively: anything unreadable is dropped rather than trusted. The file is
 * user-editable, so a hand-edit that half-breaks one pipeline must not take out the
 * others.
 */
function parseStoreFile(raw: string): StoreFile | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.pipelines)) return null;
  const pipelines: Pipeline[] = [];
  for (const entry of record.pipelines) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== "string" || !p.id.trim()) continue;
    if (typeof p.name !== "string") continue;
    if (!Array.isArray(p.steps)) continue;
    const steps = p.steps.filter((s): s is PipelineStep => isStep(s));
    if (steps.length === 0) continue;
    pipelines.push({
      id: p.id,
      name: p.name,
      steps,
      createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
      updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : Date.now(),
    });
  }
  return {
    version: typeof record.version === "number" ? record.version : 1,
    revision: typeof record.revision === "number" && record.revision >= 0 ? record.revision : 0,
    pipelines: pipelines.slice(0, MAX_PIPELINES),
  };
}

/**
 * Load the file into memory. Called once from the plugin's service `start`, which is
 * where `stateDir` becomes available (`OpenClawPluginServiceContext`).
 *
 * A broken file must NOT throw: that would fail plugin registration and take the
 * dynamic-decomposition half of the plugin down with it. Instead the bad file is
 * renamed aside — never silently overwritten, since it is the only copy of whatever
 * the user had — and the store starts empty.
 */
export function initPipelineStore(stateDir: string, logger?: Logger): void {
  storeLogger = logger;
  storePath = path.join(stateDir, FILE_NAME);
  cache = emptyFile();
  let raw: string;
  try {
    raw = fs.readFileSync(storePath, "utf8");
  } catch {
    return; // No file yet: a fresh install, not an error.
  }
  try {
    const parsed = parseStoreFile(raw);
    if (!parsed) throw new Error("unrecognized shape");
    cache = parsed;
  } catch (e) {
    const backup = `${storePath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(storePath, backup);
    } catch {
      // Best effort: if the rename fails we still refuse to start from bad data.
    }
    logger?.warn(
      `[dragon-task-orchestrator] pipelines.json unreadable (${e instanceof Error ? e.message : String(e)}); ` +
        `moved to ${backup} and starting empty`,
    );
  }
}

function snapshot(): PipelineSnapshot {
  // Deep-ish copy so callers cannot mutate the cache through the returned objects.
  return {
    revision: cache.revision,
    pipelines: cache.pipelines.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s })) })),
  };
}

function fail(code: "conflict" | "not_found", message: string): WriteResult {
  return { ok: false, code, message, ...snapshot() };
}

function failInvalid(reason: PipelineInvalidReason): WriteResult {
  return {
    ok: false,
    code: "invalid",
    message: describeInvalidReason(reason),
    reason,
    ...snapshot(),
  };
}

/** Atomic write: a partially-written JSON file would be unreadable on next start. */
function persist(next: StoreFile): void {
  cache = next;
  if (!storePath) return; // Not initialized (tests, or service never started).
  const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, storePath);
  } catch (e) {
    storeLogger?.warn(
      `[dragon-task-orchestrator] failed to persist pipelines: ${e instanceof Error ? e.message : String(e)}`,
    );
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export function listPipelines(): PipelineSnapshot {
  return snapshot();
}

export function getPipeline(id: string): Pipeline | undefined {
  const found = cache.pipelines.find((p) => p.id === id);
  return found ? { ...found, steps: found.steps.map((s) => ({ ...s })) } : undefined;
}

/**
 * Validate a candidate pipeline. Server-side because the UI is not trustworthy —
 * and because `agents.list` can change between the UI loading its dropdown and the
 * save arriving.
 */
function validate(params: {
  name: string;
  steps: PipelineStep[];
  knownAgentIds: Set<string>;
}): PipelineInvalidReason | null {
  const name = params.name.trim();
  if (!name) return { code: "name_empty" };
  if (name.length > MAX_NAME_CHARS) return { code: "name_too_long", max: MAX_NAME_CHARS };
  if (params.steps.length === 0) return { code: "no_steps" };
  if (params.steps.length > MAX_STEPS) return { code: "too_many_steps", max: MAX_STEPS };
  for (const [index, step] of params.steps.entries()) {
    // 1-based: the reason is shown to a user, who counts steps from one.
    const stepNo = index + 1;
    const agentId = step.agentId.trim();
    if (!agentId) return { code: "step_no_agent", step: stepNo };
    // Internal identities have `tools.deny: ["*"]`, so a step routed to one could
    // never do real work.
    if (INTERNAL_AGENT_IDS.has(agentId)) {
      return { code: "step_internal_agent", step: stepNo, agentId };
    }
    if (!params.knownAgentIds.has(agentId)) {
      return { code: "step_unknown_agent", step: stepNo, agentId };
    }
    if (step.instruction.length > MAX_INSTRUCTION_CHARS) {
      return { code: "step_instruction_too_long", step: stepNo, max: MAX_INSTRUCTION_CHARS };
    }
  }
  return null;
}

/** English prose for a reason, for logs and untranslated callers. */
export function describeInvalidReason(reason: PipelineInvalidReason): string {
  switch (reason.code) {
    case "name_empty":
      return "Name is required";
    case "name_too_long":
      return `Name must be at most ${reason.max} characters`;
    case "no_steps":
      return "At least one step is required";
    case "too_many_pipelines":
      return `At most ${reason.max} pipelines are allowed`;
    case "too_many_steps":
      return `At most ${reason.max} steps are allowed`;
    case "step_no_agent":
      return `Step ${reason.step} has no agent selected`;
    case "step_internal_agent":
      return `Step ${reason.step} cannot use the internal agent "${reason.agentId}"`;
    case "step_unknown_agent":
      return `Step ${reason.step} refers to agent "${reason.agentId}", which does not exist`;
    case "step_instruction_too_long":
      return `The instruction for step ${reason.step} exceeds ${reason.max} characters`;
  }
}

/**
 * Create or replace one pipeline.
 *
 * `steps` is replaced wholesale rather than patched: steps have no ids (their order IS
 * their identity), so a positional patch protocol would be more code and more ways to
 * corrupt an ordering.
 */
export function upsertPipeline(params: {
  baseRevision: number;
  id?: string;
  name: string;
  steps: PipelineStep[];
  knownAgentIds: Set<string>;
}): WriteResult {
  if (params.baseRevision !== cache.revision) {
    return fail("conflict", "Pipelines changed elsewhere; refreshed to the latest content");
  }
  const invalid = validate(params);
  if (invalid) return failInvalid(invalid);

  const steps = params.steps.map((s) => ({
    agentId: s.agentId.trim(),
    instruction: s.instruction.trim(),
  }));
  const now = Date.now();
  const pipelines = [...cache.pipelines];

  if (params.id) {
    const at = pipelines.findIndex((p) => p.id === params.id);
    if (at === -1) return fail("not_found", "That pipeline no longer exists; it may have been deleted");
    pipelines[at] = { ...pipelines[at]!, name: params.name.trim(), steps, updatedAt: now };
  } else {
    if (pipelines.length >= MAX_PIPELINES) {
      return failInvalid({ code: "too_many_pipelines", max: MAX_PIPELINES });
    }
    pipelines.push({
      id: `pl_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      name: params.name.trim(),
      steps,
      createdAt: now,
      updatedAt: now,
    });
  }
  persist({ version: SCHEMA_VERSION, revision: cache.revision + 1, pipelines });
  return { ok: true, ...snapshot() };
}

export function deletePipeline(params: { baseRevision: number; id: string }): WriteResult {
  if (params.baseRevision !== cache.revision) {
    return fail("conflict", "Pipelines changed elsewhere; refreshed to the latest content");
  }
  const pipelines = cache.pipelines.filter((p) => p.id !== params.id);
  if (pipelines.length === cache.pipelines.length) {
    return fail("not_found", "That pipeline no longer exists; it may have been deleted");
  }
  persist({ version: SCHEMA_VERSION, revision: cache.revision + 1, pipelines });
  return { ok: true, ...snapshot() };
}

/**
 * Run one write through the serialization chain.
 *
 * The revision check inside each mutation is not enough on its own: two concurrent
 * callers can both read the same revision and both pass, then interleave their writes.
 */
export async function runSerializedWrite(mutate: () => WriteResult): Promise<WriteResult> {
  const next = writeChain.then(mutate, mutate);
  writeChain = next.catch(() => undefined);
  return await next;
}

/** Test hook: the store is module-level state. */
export function resetPipelineStoreForTest(): void {
  storePath = null;
  storeLogger = undefined;
  cache = emptyFile();
  writeChain = Promise.resolve();
}
