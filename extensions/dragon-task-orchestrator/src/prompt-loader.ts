/**
 * Prompt loading from `prompts/*.md`.
 *
 * Only the verifier reads its prompt through here. The decompose/classify/
 * summarize instructions are NOT loaded at runtime: those calls run under
 * dedicated agent ids whose host `agents.list` entry carries the instructions as a
 * full `systemPromptOverride` (see session-key.ts), so their `prompts/*.md` files
 * are the editable source that must be copied into config, not a runtime input.
 *
 * Falls back to a caller-supplied default when the file is missing or unreadable.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve prompts/ whether running from src/ or a compiled dist/src/. */
function resolvePromptsDir(): string {
  const candidates = [resolve(here, "../prompts"), resolve(here, "../../prompts")];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0] as string;
}

const PROMPTS_DIR = resolvePromptsDir();
const cache = new Map<string, string>();

/** Load `prompts/{name}.md`, cached for the process lifetime. */
export function loadPrompt(name: string, fallback: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let content = fallback;
  try {
    const filePath = resolve(PROMPTS_DIR, `${name}.md`);
    if (existsSync(filePath)) {
      content = readFileSync(filePath, "utf-8").trim();
    }
  } catch {
    content = fallback;
  }
  cache.set(name, content);
  return content;
}

/** Test hook: drop cached prompts. */
export function resetPromptCache(): void {
  cache.clear();
}
