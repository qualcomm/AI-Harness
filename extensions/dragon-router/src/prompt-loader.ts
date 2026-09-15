import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the prompts/ directory. Works whether this module runs from source
 * (src/prompt-loader.ts → ../prompts) or compiled output (dist/src/prompt-loader.js
 * → ../../prompts). Without the second candidate, compiled runs resolve to a
 * non-existent dir and every loadPrompt() silently falls back to its default.
 */
function resolvePromptsDir(): string {
  const candidates = [
    resolve(__dirname, "../prompts"), // from src/       → prompts/
    resolve(__dirname, "../../prompts"), // from dist/src/ → prompts/
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0]; // fallback path; per-file fallback will kick in
}

const PROMPTS_DIR = resolvePromptsDir();

const cache = new Map<string, string>();

/** Load a prompt markdown file from prompts/, falling back to the given default. */
export function loadPrompt(name: string, fallback: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const filePath = resolve(PROMPTS_DIR, `${name}.md`);
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      cache.set(name, content);
      return content;
    }
  } catch {
    /* fall through to fallback */
  }
  console.warn(`[dragon-router] prompt "${name}" not found at ${filePath} — using built-in default`);
  cache.set(name, fallback);
  return fallback;
}
