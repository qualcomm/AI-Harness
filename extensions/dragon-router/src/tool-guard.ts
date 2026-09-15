/**
 * Tool-call PII handling.
 *
 * before_tool_call: rule-based fast check on tool params. If a param path/value
 * looks S3 (credentials, ~/.ssh, private keys), BLOCK the call — a dangerous
 * action can't be "desensitized", only prevented.
 */

/**
 * Tools that can send data OFF the device (network / shell / external services).
 * Only these are guarded — purely local file operations (write/read/edit/ls…)
 * keep data on-device and are never blocked. Matching is case-insensitive and
 * substring-based so MCP-namespaced names (e.g. "exa__web_search") also match.
 */
const OUTBOUND_TOOL_MARKERS = [
  "web_search",
  "websearch",
  "web_fetch",
  "webfetch",
  "fetch",
  "browse",
  "browser",
  "http",
  "curl",
  "bash",
  "shell",
  "exec",
  "process",
  "email",
  "send",
  "upload",
  "post",
];

/** True if the tool can exfiltrate data off-device (network/shell/external). */
export function isOutboundTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return OUTBOUND_TOOL_MARKERS.some((m) => lower.includes(m));
}

// ── S3 rule patterns for tool params (fast, synchronous) ──
const S3_PATH_MARKERS = [
  ".ssh",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".aws",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  "credentials",
  "secrets",
];
const S3_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]/i,
];

/** Collect string values from tool params (shallow + one level of nesting). */
function collectStrings(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v) && depth < 3) v.forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === "object" && depth < 3) {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val, depth + 1);
    }
  };
  visit(params, 0);
  return out;
}

/** Return a block reason if the tool params look S3-sensitive, else null. */
export function checkToolParamsS3(params: Record<string, unknown>): string | null {
  const strings = collectStrings(params);
  for (const s of strings) {
    const lower = s.toLowerCase();
    for (const marker of S3_PATH_MARKERS) {
      if (lower.includes(marker)) return `S3 path/keyword: ${marker}`;
    }
    for (const re of S3_VALUE_PATTERNS) {
      if (re.test(s)) return `S3 value pattern`;
    }
  }
  return null;
}
