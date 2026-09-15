# dragon-router 🐉

Privacy-aware + complexity-based model router for DragonClaw.

Detects each user prompt's **privacy level** (S1/S2/S3) with a local model, then
routes by **task complexity** (5 tiers → 5 models). Sensitive data is handled
locally; medium-sensitive data is reversibly desensitized, sent to the cloud,
and re-sensitized on the way back; highly-sensitive data stays on-device unless
the user explicitly opts in.

## Routing logic

Privacy detection runs in **`before_agent_reply`** (before the agent starts), so
an S3 prompt can short-circuit with a prompt to the user and never touch the LLM.
Actual model selection happens in **`before_model_resolve`**; the two hooks pass
the detected level through an in-memory cache to avoid re-detecting.

```
用户 prompt
   │
   ▼ before_agent_reply  ── 本地模型判隐私级别 (S1/S2/S3)
   │
   ├─ S1 (非敏感) ────────→ before_model_resolve: 判复杂度(5级) → 映射 5 个 LLM 之一 → 直连
   │
   ├─ S2 (中等敏感) ──────→ 可逆脱敏(占位符↔原值) → 判脱敏后复杂度 → 选 LLM
   │                        → 本地代理转发云端 → 响应反脱敏 → 返回用户
   │
   └─ S3 (高度敏感) ──────→ 在隔离子 session 中跑完(固定本地 S3 模型,无云端出口)
                            → 结果直接回复,原始 prompt/reply 从不进入主 session 历史
```

### S3 isolation (no `/cloud` escape hatch)

An S3 prompt is never processed in the main session, and never has a cloud option.
`before_agent_reply` spawns a dedicated, one-shot isolated child session (via
`api.runtime.subagent.run`) pinned to the fixed local `s3Model`, waits for it to
finish, and replies with its output. Because the prompt and reply never enter the
*main* session's transcript, they can never be replayed into a later cloud request
from that session. This replaces an earlier design (a `/local` vs `/cloud`
confirmation, processed in the main session) where S3 content injected via
`prependContext` on the follow-up turn was persisted to the main session's
transcript and could resurface in a later S1/S2 cloud request from that same
session. See `src/s3-isolation.ts` for the full rationale.

The isolated child session runs under its **own agentId** (`s3-isolated`, declared
in `openclaw.json`'s `agents.list`) rather than reusing the parent's — its
sessionKey is `agent:s3-isolated:<sha256(parentSessionKey)>`, built via
`buildAgentMainSessionKey`. A dedicated agentId gives the child its own workspace
directory and its own model allowlist, so the parent agent's config doesn't need
to trust the local S3 model for anything other than the documented fail-safe edge
case (see Configuration below). `isS3ChildSession` recognizes the child by
resolving its sessionKey's agentId (not by string-matching a suffix), and it is
treated as an internal session by all other hooks (never re-classified — this also
prevents infinite recursion), except `before_tool_call`, which still guards its
outbound tool calls exactly like a direct S3 session would, and the tool-result
desensitize middleware, which explicitly skips it (see Tool-call handling below).

**A separate agentId alone does NOT stop the main session's own LLM from reading
the isolated child's transcript.** OpenClaw's built-in `sessions_history` /
`sessions_list` tools grant access based on sessionKey ownership
(`spawnedBy`/`parentSessionKey` — stamped on every `api.runtime.subagent.run` call
regardless of the child's agentId) *before* checking whether the caller and target
belong to different agents. Under the default `tools.sessions.visibility: "tree"`,
the main session can call `sessions_history` with the child's sessionKey and read
it back in full — silently defeating the isolation. Closing this requires setting
`tools.sessions.visibility: "self"` globally (see "Session visibility trade-off"
below) — this plugin's isolation guarantee is NOT complete without that setting.

Requires the OpenClaw host to trust this plugin for subagent model override:
`plugins.entries.dragon-router.subagent.allowModelOverride: true` (or an
equivalent allowlist) in `openclaw.json` — without it, every S3 turn fails and
falls back to the generic failure reply.

### Session visibility trade-off

`tools.sessions.visibility: "self"` (see Installation below) is required to fully
close the cross-session read gap described above. It is a **global, binary
setting** with no finer-grained alternative in OpenClaw today:

- Under the default `"tree"`, any session can use `sessions_history`/`sessions_list`
  to read the transcript of any session it (transitively) spawned — including,
  crucially, the S3-isolated child.
- Under `"self"`, a session can only ever see its own transcript. This also
  disables the normal "spawn a subagent task, then ask the main agent what it
  found" workflow (`sessions_spawn` → later `sessions_history` on the child) for
  **everything**, not just the S3-isolated child — there is no way to scope this
  setting to just one child sessionKey.

If your setup relies on reviewing spawned-subagent results from the main session,
you must choose between that workflow and closing this specific leak. There is no
middle ground in the current OpenClaw codebase.

## Installation

If installing via link mode:

```
pnpm openclaw plugins install --link ..\dragon-router
```

you must also enable conversation access in `openclaw.json`, otherwise the plugin
cannot use the plugin hooks.

Non-built-in (third-party) plugins must explicitly declare `allowConversationAccess: true`
in order to access plugin hooks. S3 isolation additionally requires:

1. **`subagent.allowModelOverride: true`** on the plugin entry, so this plugin
   can pin the isolated child session to the fixed local S3 model (see "S3
   isolation" above) — without it, every S3 turn fails.
2. **A dedicated `s3-isolated` agent** declared in `agents.list`, with its own
   `workspace` and a `models` allowlist containing the local S3 model — without
   it, every S3 turn fails with `Model override "..." is not allowed for agent
   "s3-isolated"`.
3. **The local S3 model also allowlisted on the `main` agent** (or whichever
   agent(s) dragon-router runs in) — the rare S3 detector-inconsistency fail-safe
   in `before_model_resolve` overrides the model directly in the *main* session
   (isolation isn't available at that point; see `src/hooks.ts`), so it needs the
   same allowlist entry there too.
4. **`tools.sessions.visibility: "self"`** globally, if you want the isolation
   guarantee to actually hold (see "Session visibility trade-off" above) — this
   is a real trade-off against subagent-review workflows, decide deliberately.

```json
{
  "agents": {
    "defaults": {
      "models": {
        "local-inference/openbmb/MiniCPM4.1-8B-GGUF": { "alias": "minicpm-local" }
      }
    },
    "list": [
      { "id": "main" },
      {
        "id": "s3-isolated",
        "workspace": "C:\\path\\to\\workspace-s3-isolated",
        "model": { "primary": "local-inference/openbmb/MiniCPM4.1-8B-GGUF" },
        "models": {
          "local-inference/openbmb/MiniCPM4.1-8B-GGUF": { "alias": "minicpm-local" }
        }
      }
    ]
  },
  "tools": {
    "sessions": { "visibility": "self" }
  },
  "plugins": {
    "entries": {
      "dragon-router": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "subagent": {
          "allowModelOverride": true
        },
        "config": {
          "dragonRouter": {
            // refer to config.example.json
          }
        }
      }
    }
  }
}
```

## Components

| File | Role |
| --- | --- |
| `index.ts` | Entry: load config, register virtual provider + proxy service + hooks + tool-result desensitize middleware |
| `src/hooks.ts` | 5 hooks: `before_agent_reply` (privacy detect + S3 isolated-run short-circuit), `before_model_resolve` (S1/S2 routing + S3 fail-safe edge case), `before_prompt_build` (inject task text), `before_tool_call` (S3 outbound-tool guard), `message_sending` (fallback re-sensitize) |
| `src/s3-isolation.ts` | Spawns/waits/reads the isolated S3 child session (dedicated `s3-isolated` agentId, deterministic sessionKey derived from a hash of the parent's) via `api.runtime.subagent`; recursion guard (`isS3ChildSession`, resolves the sessionKey's agentId rather than string-matching) |
| `src/tool-result-desensitize.ts` | `AgentToolResultMiddleware` for local read-only tools (`read`/`ls`/`glob`/`grep`/`find`): desensitizes tool results before they reach the transcript/cloud |
| `src/privacy-detector.ts` | Local-model S1/S2/S3 classifier (no cache; fail → S3) |
| `src/complexity-classifier.ts` | Local-model tier 1-5 classifier (fail → tier 2) |
| `src/desensitizer.ts` | Reversible desensitize: extract PII → unique placeholders `⟦PII_xxxx⟧` (text embedded in the system prompt to keep small models on-task) |
| `src/parse-helpers.ts` | Normalize local-model output (strip ```` ```json ```` fences, unescape double-encoded quotes) before parsing |
| `src/pii-map-store.ts` | Session + global placeholder↔original map, with TTL cleanup |
| `src/proxy.ts` | Local HTTP proxy: strip markers, forward upstream **non-streaming**, re-sensitize complete text, convert back to SSE; forwards `tool_calls` and re-sensitizes tool-call arguments |
| `src/provider.ts` | Virtual provider `dragon-router-proxy` + model→upstream mirror |
| `src/router-decision.ts` | level + complexity → final model target |
| `src/tool-guard.ts` | `before_tool_call` guard: block sensitive params on **outbound** tools in **S3** sessions (main or isolated child) |
| `src/strip-meta.ts` | Strip OpenClaw inbound metadata (Sender/Conversation blocks, timestamps) before local classification |
| `prompts/*.md` | Editable classification / extraction prompts (built-in fallbacks used when not present in `dist/`) |

## Configuration

Under the `dragonRouter` key (see `config.example.json`):

- `localModel` — local model for detection, classification, desensitize. Fields:
  `endpoint`, `model` (sent as request-body `model`), `api` (`"ollama"` → `/api/chat`,
  or `"openai-compatible"` → `/v1/chat/completions`; unknown values fall back to
  `openai-compatible`).
- `complexityTiers` — `"1".."5"` → `{provider, model}`. **Override with your own models.**
- `s3Model` — model for fully-local S3 handling. Must be allowlisted under BOTH
  the `s3-isolated` agent (its normal execution model) AND the main agent (the
  rare direct fail-safe edge case) — see Installation above.
- `proxyPort` — local proxy port (default 8404).
- `cacheTtlMs` — classification cache TTL (default 5 min).

## Design notes

- **Reversible desensitization** (unlike a `[REDACTED]` scrubber): placeholders are
  globally unique so the proxy can restore them without knowing the session.
- **Non-streaming proxy**: the proxy calls upstream non-streaming and re-sensitizes
  the *complete* text, avoiding placeholders split across SSE chunks, then converts
  the completion back to SSE if the client asked for a stream. Tool calls and their
  arguments are forwarded/restored too (`reSensitizeChunk` is kept for tests).
- **Robust parsing**: local-model outputs are normalized (code fences stripped,
  double-encoded quotes unescaped) so `{\"tier\":5}` or ```` ```json … ``` ````
  parse reliably instead of relying on lenient fallbacks.
- **Fail-safe**: local model down → privacy detection returns S3; S2 desensitize
  failure → route local, direct (task text still injected, current turn only).
  S3 isolated-run failure → generic failure reply, never falls through to the
  main session. PII never leaks to cloud on failure.
- **PII map lifecycle**: cleared after `message_sending`; TTL-swept at 10 min.

## Tool-call handling

- `before_tool_call` — guards when the turn is **S3**: either the isolated child
  session unconditionally, or the main session's rare direct-S3 fail-safe edge
  case — **and** the tool can send data off-device (network / shell / external,
  e.g. `web_search`, `bash`, `fetch`). Local-only tools (`write`/`read`/`edit`)
  never leave the device and are not blocked. When a guarded call carries
  sensitive params (`~/.ssh`, `id_rsa`, `.aws`, private-key / `api_key=` values),
  it is **blocked** — a dangerous action can't be desensitized, only prevented.
- `AgentToolResultMiddleware` (`src/tool-result-desensitize.ts`) — reversibly
  desensitizes results from local read-only tools (`read`/`ls`/`glob`/`grep`/
  `find`) via the local model before they reach the transcript, so PII pulled in
  from files/directories doesn't leak on a later cloud turn. Registered via
  `api.registerAgentToolResultMiddleware`, which is awaited by the host — unlike
  the now-removed `tool_result_persist` hook, which is synchronous and silently
  dropped this plugin's async rewrite (see git history for that dead end).
  Explicitly skips the S3-isolated child session (`isS3ChildSession`): that
  session never leaves the device, so replacing real content with placeholders
  there would just corrupt the reply — nothing ever re-sensitizes it back.

## Known limitations / TODO

- Prompt `.md` files are not copied into `dist/` by the build, so compiled runs use
  the built-in fallback prompts (complete; `.md` acts as an editable override only
  when present).
- Combine privacy + complexity into a single local call to save one round-trip.
- No statistics / dashboard / hot-reload / pluggable custom routers.
- S3 isolated runs add a full subagent round-trip's latency (local model can be
  slow — tens of seconds observed with small models) compared to the old direct
  `/local` path.
