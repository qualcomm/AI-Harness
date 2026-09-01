/**
 * Decomposition plan validation and cleaning.
 *
 * THE ORDER OF THE STEPS IS LOAD-BEARING. The review doc's highest-severity
 * finding was a dangling-dependency defect: dropping a subtask and renumbering
 * without rewriting the surviving dependency references leaves references that
 * still satisfy `dep < index` numerically but point at something that no longer
 * exists. Those subtasks then never become ready and get silently dropped by the
 * layering step.
 *
 * The invariant: after ANY renumber or drop, dependency references are rewritten
 * before the next step runs. Steps must not be reordered.
 *
 *   0. Shape normalization  — discard malformed entries, never throw
 *   1. Renumber by position — rewrite deps via first-occurrence position
 *   2. Drop empty descriptions — compact indexes, rewrite deps again
 *   3. Truncate long descriptions
 *   4. Cap subtask count
 *   5. sanitizeDependencies — legality filter, dedupe, per-subtask cap
 */

import { truncate } from "./sanitize.js";
import type { DecomposePlan, SubtaskPlan, ValidatedPlan } from "./types.js";

/** Title budget — a short label, not a second description. */
const MAX_TITLE_CHARS = 60;

/**
 * Hand-off contract caps.
 *
 * The contract is repeated into two prompts (the worker's and the verifier's), so an
 * unbounded list would be paid for twice. It is also a checklist, not a specification:
 * past ~8 items a model stops treating each entry as individually required.
 */
const MAX_HANDOFF_ITEMS = 8;
const MAX_HANDOFF_ITEM_CHARS = 120;

/**
 * Clean the hand-off contract, or return undefined when there is nothing usable.
 *
 * `undefined` rather than `[]` because absent and empty mean the same thing to every
 * consumer, and keeping one representation means each of them needs one check, not two.
 *
 * The return value must be ASSIGNED, not spread. An earlier version returned a partial
 * (`{}` when unusable) to be spread after `...s`, which does not remove the key already
 * spread from the raw entry — so `handoffContract: 42` survived normalization untouched
 * and later reached `(subtask.handoffContract ?? []).some(...)`, where `42.some` is not a
 * function. Cleaning a model-supplied field has to overwrite it, not merely decline to
 * replace it.
 */
function normalizeHandoffContract(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => truncate(v.trim(), MAX_HANDOFF_ITEM_CHARS))
    .filter((v) => v.length > 0)
    .slice(0, MAX_HANDOFF_ITEMS);
  return items.length > 0 ? items : undefined;
}

/**
 * Final dependency pass: legality filter, dedupe, per-subtask cap.
 *
 * By the time this runs, dangling references are already gone (steps 1-2 rewrote
 * them), so the `dep < index` filter here is defensive rather than primary.
 *
 * Dedupe matters beyond tidiness: a plan induced to repeat one dependency value
 * hundreds of times would cause redundant result lookups and repeated
 * prior-context string growth before truncation ever runs.
 */
export function sanitizeDependencies(
  subtasks: SubtaskPlan[],
  maxDepsPerSubtask: number,
): { cleaned: SubtaskPlan[]; truncatedDeps: SubtaskPlan[] } {
  const truncatedDeps: SubtaskPlan[] = [];
  const cleaned = subtasks.map((s) => {
    const deps = s.needsPriorResults ?? [];
    const valid = deps.filter((dep) => dep < s.id);
    const deduped = [...new Set(valid)];
    const kept = deduped.slice(0, maxDepsPerSubtask);
    if (kept.length < deduped.length) truncatedDeps.push(s);
    return { ...s, needsPriorResults: kept };
  });
  return { cleaned, truncatedDeps };
}

/**
 * Runtime shape check. TypeScript types are compile-time only, so a parse that
 * succeeded can still yield `subtasks: null`, a numeric `description`, or a
 * string-typed dependency — a model swap, higher temperature, or a cut-off
 * response is enough to produce any of these.
 *
 * Malformed entries are discarded outright and counted in NO statistic: an entry
 * that never had a valid shape does not qualify as "valid but truncated". The
 * caller's 0-subtask branch then handles the fallback, the same as a parse
 * failure would.
 */
function normalizeShape(plan: unknown): SubtaskPlan[] {
  const raw = (plan as DecomposePlan | null | undefined)?.subtasks;
  const rawSubtasks: unknown[] = Array.isArray(raw) ? raw : [];
  return rawSubtasks
    .filter((s): s is SubtaskPlan => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return false;
      const r = s as Record<string, unknown>;
      return (
        typeof r.description === "string" &&
        typeof r.id === "number" &&
        Number.isInteger(r.id) &&
        (r.needsPriorResults === undefined || Array.isArray(r.needsPriorResults))
      );
    })
    .map((s) => ({
      ...s,
      title: typeof s.title === "string" ? s.title : "",
      acceptanceCriteria: typeof s.acceptanceCriteria === "string" ? s.acceptanceCriteria : "",
      // Assigned, not spread: this must OVERWRITE whatever `...s` brought in, including a
      // non-array. See normalizeHandoffContract.
      handoffContract: normalizeHandoffContract(s.handoffContract),
      // Non-integer members (e.g. string-typed numbers) would pollute the later
      // `dep < id` comparisons, so filter them here.
      needsPriorResults: (s.needsPriorResults ?? []).filter(
        (d: unknown): d is number => typeof d === "number" && Number.isInteger(d),
      ),
    }));
}

/** Rewrite dependency references through an old-id -> new-id map. */
function remapDeps(subtasks: SubtaskPlan[], map: Map<number, number>): SubtaskPlan[] {
  return subtasks.map((s, i) => ({
    ...s,
    id: i,
    // A reference with no entry in the map is dropped outright. It must NOT be
    // replaced with a sentinel such as -1: that would pass the later
    // `dep < id` check and survive, yet never be satisfiable, which is the
    // dangling-dependency bug in another guise.
    needsPriorResults: (s.needsPriorResults ?? [])
      .filter((d) => map.has(d))
      .map((d) => map.get(d) as number),
  }));
}

/**
 * Validate and clean a raw decomposition plan.
 *
 * Note what this does NOT do: decide the 0/1-survivor fallback. That judgment
 * belongs to the caller, because it must be made on the POST-cleaning count —
 * dropping empty descriptions reduces the survivor count, so testing the model's
 * raw output alone would let a 1-survivor plan reach the pipeline.
 */
export function validateDecomposePlan(
  plan: unknown,
  limits: { maxSubtasks: number; maxDescriptionChars: number; maxDepsPerSubtask: number },
): ValidatedPlan {
  // Step 0: shape normalization.
  const shaped = normalizeShape(plan);

  // Step 1: ignore the model's self-reported id; renumber by array position.
  // Dependency values are rewritten via "position of that value's FIRST
  // occurrence" — duplicate old ids are not a single-valued function, so
  // taking the first occurrence removes the one-to-many ambiguity.
  const firstIndexOf = new Map<number, number>();
  shaped.forEach((s, i) => {
    if (!firstIndexOf.has(s.id)) firstIndexOf.set(s.id, i);
  });
  let subtasks = remapDeps(shaped, firstIndexOf);

  // Step 2: drop empty descriptions, compact ids, rewrite deps again.
  const droppedEmptyDescriptions = subtasks.filter((s) => s.description.trim() === "");
  const survivors = subtasks.filter((s) => s.description.trim() !== "");
  const remap = new Map<number, number>();
  survivors.forEach((s, i) => remap.set(s.id, i));
  subtasks = remapDeps(survivors, remap);

  // Step 3: truncate over-long descriptions/title/acceptanceCriteria. Record the
  // pre-truncation entries so the notice can show what the user originally asked for.
  const truncatedDescriptions = subtasks.filter(
    (s) => s.description.length > limits.maxDescriptionChars,
  );
  subtasks = subtasks.map((s) => ({
    ...s,
    title: truncate(s.title, MAX_TITLE_CHARS),
    description: truncate(s.description, limits.maxDescriptionChars),
    acceptanceCriteria: s.acceptanceCriteria
      ? truncate(s.acceptanceCriteria, limits.maxDescriptionChars)
      : s.acceptanceCriteria,
  }));

  // Step 4: cap the count. Safe here precisely because indexes are already
  // normalized and deps already cleaned — keeping the first N cannot create a new
  // dangling reference, since a kept subtask's legal deps point at earlier
  // (therefore also kept) subtasks. Running this before step 1 would slice by the
  // model's raw ordering instead, breaking that guarantee.
  const droppedSubtasks = subtasks.slice(limits.maxSubtasks);
  subtasks = subtasks.slice(0, limits.maxSubtasks);

  // Step 5: final dependency pass.
  const { cleaned, truncatedDeps } = sanitizeDependencies(subtasks, limits.maxDepsPerSubtask);

  return {
    subtasks: cleaned,
    droppedSubtasks,
    droppedEmptyDescriptions,
    truncatedDescriptions,
    truncatedDeps,
  };
}
