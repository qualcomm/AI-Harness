# GenieX Manager

Manages the `geniex serve` process lifecycle and on-device model downloads for
the [`geniex`](../geniex/README.md) provider plugin.

## Why this is a separate plugin

A bundled plugin only gets loaded at **gateway startup** when its manifest
declares no provider/channel/contract surface — see
`isGatewayStartupSidecar` in
[`src/plugins/channel-plugin-ids.ts`](../../src/plugins/channel-plugin-ids.ts).
`geniex` declares `providers: ["geniex"]`, so core treats its `register()` as
lazily loaded — resolved when a chat request needs a GenieX model, not
necessarily at boot. That is the right behavior for inference, but this
plugin's job — owning the `geniex serve` child process and its gateway
methods (`geniex.status`, `geniex.models.*`, `geniex.serve.*`,
`geniex.chipset.*`) — needs to run unconditionally from boot, the same way
`dragon-router` and `dragon-task-orchestrator` do.

Giving that job its own manifest with no `providers` field is what makes core
treat it as a startup sidecar. Splitting it out of `geniex` was the fix for a
real bug: `geniex.status` returned `unknown method` at runtime because the
provider plugin's `register()` — where `registerGatewayMethod` was called —
never ran until a chat request touched GenieX.

## Enablement

Both plugins ship disabled by default and each registers its own
`registerAutoEnableProbe` with the same criteria (Snapdragon host + `geniex`
CLI on PATH), so they auto-enable together without the user having to enable
them separately. See [`geniex`'s README](../geniex/README.md#platform-and-auto-enable)
for the platform/CLI detection details — that logic is duplicated here rather
than imported, because extension production code may not use relative imports
that escape its own package root (see `extensions/AGENTS.md`).

## What lives here vs. in `geniex`

| | `geniex` | `geniex-manager` |
| --- | --- | --- |
| Manifest | `providers: ["geniex"]` | no providers/channels/contracts (sidecar) |
| Owns | chat model discovery, per-request compute injection | the `geniex serve` process, model downloads, chipset config |
| Config | `plugins.entries.geniex.config.models` (per-model compute) | `plugins.entries.geniex-manager.config.serve` (process defaults) |

The gateway method names are unprefixed by plugin id (`geniex.status`, not
`geniex-manager.status`) — they describe GenieX, not which plugin registers
them, so the split is invisible to the UI and to anyone calling the gateway
API directly.

## Service lifecycle

Started and stopped by `registerService`, tied to the gateway process:

- **Zero models is a valid ready state.** `geniex serve` only resolves the
  host chipset and starts a keep-alive ticker; models load lazily on the
  first request (GenieX `cli/server/server.go`). So the process comes up
  before the user has downloaded anything, and a model pulled later needs no
  restart.
- **`serve.mode: "auto"` (default) reuses an instance already listening** on
  the configured host instead of spawning a second one, so a `geniex serve`
  the user started by hand is never fought over the port. Only a process this
  plugin spawned is ever stopped by it.
- **Shutdown is graceful.** GenieX documents that skipping its `DeInit`
  "pins NPU buffers till reboot", so `stop()` sends SIGTERM and waits before
  escalating to SIGKILL.
- **Crashes back off and give up.** An unexpected exit retries with
  increasing delay, capped at 4 attempts — past that point the failure is
  almost certainly a taken port or a broken install that retries cannot fix.

## Model management

See [`geniex`'s README](../geniex/README.md) for why the downloadable-model
list bypasses `geniex model list` (interactive-picker hang risk, table-only
output) in favor of reading Qualcomm AI Hub's public JSON directly, and why
download progress is derived by polling `geniex list --format json` instead of
parsing GenieX's ANSI progress bar — those are this plugin's own
`src/aihub.ts` and `src/pull-jobs.ts`, documented in their module comments.
