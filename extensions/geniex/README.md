# GenieX Provider

On-device inference on Qualcomm Snapdragon via [GenieX](https://github.com/qualcomm/GenieX),
Qualcomm's on-device Gen AI inference runtime. Models run on the Hexagon NPU, Adreno GPU, or
CPU — data never leaves the machine.

This plugin owns chat model discovery and per-request compute injection. The `geniex serve`
process itself, model downloads, and chipset configuration are owned by the companion
[`geniex-manager`](../geniex-manager/README.md) plugin — see that README for why the two
are split.

## Prerequisites

1. **A Snapdragon device** — Windows ARM64 (Snapdragon X / X2 series), Linux ARM64
   (Dragonwing), or Android.
2. **The GenieX CLI installed** — download from
   [releases](https://github.com/qualcomm/GenieX/releases). The Windows installer edits the
   system PATH, but the gateway process already read its environment at startup, so
   **restarting the gateway is required after installing**, not just re-probing.
3. **At least one model downloaded** — e.g. `geniex pull qualcomm/Qwen3-4B`.

The inference server is managed automatically by `geniex-manager`; nothing needs to be
started by hand.

## Platform and auto-enable

This plugin ships disabled by default. `registerAutoEnableProbe` only enables it when the
**platform is supported and `geniex` is on PATH** — the platform check is pure memory
access, so hosts that can never run GenieX pay nothing, and no one sees a provider that
always fails discovery.

## How it works

`geniex serve` exposes an OpenAI-compatible API, so this plugin works through the standard
`openai-completions` transport with no custom protocol adapter.

- **Discovery**: probes `GET /v1/` for reachability. **Not gated on a non-empty model
  list** — `geniex serve` starts fine with zero models (they load lazily per request), so an
  empty list is a valid ready state.
- **Model catalog**: comes from `GET /v1/models`. GenieX attaches `model_type` (`"llm"` /
  `"vlm"`) to the OpenAI response, used to mark vision models' image-input support.
- **Auth**: GenieX's local server has no authentication; the plugin uses the standard local
  marker and never collects or stores a credential. `GENIEX_API_KEY` is only for reverse-proxy
  deployments.

## Runtime and compute units

A model's **runtime is fixed at download time**, determined by the source format — the user
cannot choose or change it:

| Download source | Runtime | Available compute units |
| --- | --- | --- |
| Hugging Face / ModelScope / Docker Hub (GGUF) | `llama_cpp` | CPU / GPU / NPU |
| Qualcomm AI Hub (pre-compiled bundle) | `qairt` | **NPU only** |

Changing runtime means downloading the same model again from a different source. `qairt` is
NPU-only — sending any other compute unit is coerced back to NPU by GenieX with a warning.

## Configuration

Per-model settings live in this plugin's own config (`ModelDefinitionConfig` is a fixed core
shape with no vendor extension slot). Keys use GenieX's own `name[:precision]` form; a bare
`name` entry applies to every precision of that model.

```json
{
  "plugins": {
    "entries": {
      "geniex": {
        "config": {
          "models": {
            "unsloth/gpt-oss-20b-GGUF:F16": { "compute": "cpu" },
            "qualcomm/Qwen3-4B": { "compute": "npu" }
          }
        }
      }
    }
  }
}
```

| Field | Description |
| --- | --- |
| `compute` | `cpu` / `gpu` / `npu` / `hybrid`. Ignored by `qairt` models. `hybrid` has no dedicated branch in GenieX's device resolution, so it behaves as "unspecified — let llama.cpp decide" rather than a distinct mode. |
| `contextSize` | llama_cpp's `nctx`. Ignored by `qairt` models. |
| `gpuLayers` | llama_cpp's `ngl`: `0` = pure CPU, `-1` = all layers. Ignored by `qairt` models. |
| `specDraftModel` | Draft model (`org/repo[:precision]`) for MTP speculative decoding; setting it sends `spec_type: "draft-mtp"`. `llama_cpp` and text-only. The draft must already be pulled (`geniex pull`) — `geniex serve` never downloads it and errors mid-request if it is missing. |
| `specDraftTokens` / `specDraftMin` / `specDraftPMin` | `spec_n_max` / `spec_n_min` / `spec_p_min`. Ignored unless `specDraftModel` is set. |
| `includeModels` | Model ids to force back into the chat catalog, for correcting an embedding-model false positive. |

`contextSize` also sets the context window the model is advertised with, so the gateway
compacts history against the window GenieX will really load instead of the generic 128k
default. Set it whenever the model's real `nctx` is smaller.

The `spec_*` fields are part of GenieX's model cache key: send the same values on every
request, or each change reloads the model. The target and draft are resident together, so
plan for the combined disk and RAM. The draft model is only a helper — it should not be
selected in chat.

These fields are **request-body fields** on `/v1/chat/completions`. GenieX prefills them from
`serve`'s startup flags, then lets the request body override whatever it contains — so
per-model compute works against a single long-running `geniex serve`, **no restart needed**
to switch compute units.

> Note: GenieX's keep-alive cache holds only one model resident at a time. Switching models
> or changing compute unit triggers an unload + reload; loading an NPU model can take
> several seconds.

## Embedding models

GenieX reports every non-VLM model as `model_type: "llm"` (including sentence-embedding
models like `bge-m3`), and `geniex serve` has **no** `/v1/embeddings` route. An embedding
model that reaches the chat catalog can therefore only fail once selected.

The plugin excludes them by name pattern (`bge-` / `embed` / `e5-` / `gte-` / etc.) — the only
signal available; the GGUF architecture field would distinguish them, but GenieX does not
expose it. Use `includeModels` to add a false positive back.
