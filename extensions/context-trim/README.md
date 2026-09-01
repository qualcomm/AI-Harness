# Context Trim

[中文文档](README.zh.md)

An OpenClaw plugin that replaces the default system prompt with a compact version for low-context local or edge models. Designed for models running under 16K context windows where the full OpenClaw system prompt is too large.

## How It Works

On every `before_prompt_build` event, the plugin checks whether the current provider/model matches a configured target. If it matches, it replaces the system prompt with a trimmed version built from OpenClaw's `minimal` prompt mode, then appends a character-budget-limited project context summary and any extra instructions.

The plugin runs at **priority 10**, so it takes precedence over other plugins that also replace the system prompt at default priority (0).

## Minimal vs Full Prompt

`minimal` mode keeps only the sections necessary for tool-calling agents:

| Included | Excluded |
|---|---|
| Tooling (runtime-filtered tool list) | Memory |
| Tool Call Style | Messaging / Voice |
| Safety | Assistant Output Directives |
| OpenClaw CLI Quick Reference | Silent Replies / Heartbeats |
| Skills (whitelist only) | Execution Bias |
| Workspace | Model Aliases / Docs / Self-Update |
| Runtime | Authorized Senders |

A typical minimal prompt is **~1,000–1,500 tokens**, compared to 3,000+ for a full prompt.

## Installation

Add `context-trim` to the `plugins.allow` list in `openclaw.json`, then configure it under `plugins.entries`:

```json
{
  "plugins": {
    "allow": ["context-trim"],
    "entries": {
      "context-trim": {
        "enabled": true,
        "config": {
          "enabled": true,
          "targets": [
            { "provider": "openai-local", "model": "gpt-oss-20b" }
          ]
        }
      }
    }
  }
}
```

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch for the plugin. |
| `targets` | `{ provider, model }[]` | `[]` | Provider/model pairs that trigger the compact prompt. Both fields must match exactly (case-insensitive provider). |
| `skills` | string[] | `[]` | Whitelist of skill names to inject. Only skills listed here are loaded — leave empty to inject none. |
| `includeProjectContext` | boolean | `true` | Whether to append a summarized project context section. |
| `projectFiles` | string[] | `["AGENTS.md", "TOOLS.md"]` | Workspace files to summarize for project context. |
| `perFileCharBudget` | integer (80–8000) | `500` | Maximum characters kept from each project file. |
| `totalProjectCharBudget` | integer (200–20000) | `1200` | Maximum total characters across all project files. |
| `extraInstructions` | string | — | Optional operator instructions appended after project context. |
| `logging` | boolean | `false` | Log char count and estimated token count each time the prompt is replaced. |

### Full Example

```json
{
  "plugins": {
    "entries": {
      "context-trim": {
        "enabled": true,
        "config": {
          // default set to true
          "enabled": true,
          "targets": [
            { "provider": "openai-local", "model": "gpt-oss-20b" }
          ],
          "skills": ["weather", "calendar"],
          "includeProjectContext": true,
          "projectFiles": ["AGENTS.md", "TOOLS.md"],
          "perFileCharBudget": 400,
          "totalProjectCharBudget": 800,
          "extraInstructions": "Reply in Chinese unless the user writes in another language.",
          "logging": true
        }
      }
    }
  }
}
```

## Skills

Skills are injected via a **whitelist** — only skill names listed in `skills` are loaded. This differs from the default OpenClaw behavior, which loads all workspace skills in full.

The skill must have a valid `SKILL.md` with both a `name` and a `description` field in its frontmatter. The `name` in frontmatter must match the string in the `skills` array exactly (directory name is used as fallback if `name` is absent).

Skills are searched in the standard OpenClaw skill directories:

1. `config.skills.load.extraDirs` (lowest priority)
2. OpenClaw bundled skills
3. `~/.openclaw/skills` (managed)
4. `~/.agents/skills` (personal)
5. `{workspaceDir}/.agents/skills` (project)
6. `{workspaceDir}/skills` (highest priority)

To use a skill from a custom directory, add the directory to `skills.load.extraDirs` in `openclaw.json`:

```json
{
  "skills": {
    "load": {
      "extraDirs": ["/path/to/your/skills"]
    }
  }
}
```

## Project Context

When `includeProjectContext` is enabled, the plugin reads each file in `projectFiles` from the workspace directory, strips blank lines and code fences, then truncates to `perFileCharBudget` characters at a word boundary. The total across all files is further capped by `totalProjectCharBudget`.

This produces a compact `# Project Context` section that fits well within tight context windows.

## Debugging

Set the `CONTEXT_TRIM_DUMP_FILE` environment variable to a file path to dump the generated system prompt to disk on every run:

```bash
CONTEXT_TRIM_DUMP_FILE=/tmp/context-trim-dump.json openclaw start
```

The dump file is a JSON object:

```json
{
  "generatedAt": "2026-04-24T03:27:12.380Z",
  "provider": "openai-local",
  "model": "gpt-oss-20b",
  "workspaceDir": "/path/to/workspace",
  "chars": 6027,
  "systemPromptText": "..."
}
```

When `logging: true`, each replacement also emits an info log:

```
context-trim: replaced system prompt for openai-local/gpt-oss-20b (6027 chars, ~1507 tokens)
```

## Configuration Example: 8K Models

### Full Configuration

#### 1. Model Declaration (declare `contextWindow`)

OpenClaw's default minimum `contextWindow` is 16K — requests from models below that threshold are blocked. DragonClaw overrides this with:

```json
{
  "agents": {
    "defaults": {
      "contextWindowHardMin": 8000
    }
  }
}
```

Also explicitly declare the `contextWindow` for your model:

```json
{
  "providers": {
    "ollama": {
      "models": [
        {
          "id": "your-local-model",
          "contextWindow": 8192
        }
      ]
    }
  }
}
```

#### 2. Plugin Configuration

```json
{
  "plugins": {
    "allow": ["context-trim", "lossless-claw"],
    "slots": {
      "contextEngine": "lossless-claw"
    },
    "entries": {
      "context-trim": {
        "enabled": true,
        "config": {
          "targets": [
            { "provider": "ollama", "model": "your-local-model" }
          ],
          "includeProjectContext": false,
          "perFileCharBudget": 300,
          "totalProjectCharBudget": 600
        }
      },
      "lossless-claw": {
        "enabled": true,
        "config": {
          "contextThreshold": 0.72,
          "freshTailCount": 8,
          "leafChunkTokens": 2000,
          "maxAssemblyTokenBudget": 4096,
          "summaryModel": "ollama/your-local-model"
        }
      }
    }
  }
}
```

#### Key Parameters

| Parameter | Value | Description |
|---|---|---|
| `contextWindowHardMin` | `8000` | Overrides the default hard minimum of 16000, allowing 8K models to pass the block check. |
| `contextWindow` | `8192` | Must be declared explicitly; otherwise the framework defaults to 200,000 and lossless-claw never triggers compaction. |
| `contextThreshold` | `0.72` | Triggers compaction at 72% of the budget (≈ 4096 × 0.72 = 2949 tokens). |
| `freshTailCount` | `8` | Keeps the 8 most recent messages raw, never compressed. |
| `leafChunkTokens` | `2000` | Token ceiling per leaf summary chunk. |
| `includeProjectContext` | `false` | Disabled for 8K contexts to save tokens; workspace `.md` files are not injected. |
| `maxAssemblyTokenBudget` | `4096` | Hard cap on tokens assembled per request. |
| `summaryModel` | `provider/model` | Model used to summarize conversation history into leaf nodes. |

---

## Configuration Example: 16K Models

### Full Configuration

```json
{
  "plugins": {
    "allow": ["context-trim", "lossless-claw"],
    "slots": {
      "contextEngine": "lossless-claw"
    },
    "context-trim": {
      "enabled": true,
      "config": {
        "targets": [
          { "provider": "your-provider", "model": "your-16k-model" }
        ],
        "includeProjectContext": true,
        "perFileCharBudget": 800,
        "totalProjectCharBudget": 2400,
        "logging": true
      },
    },
    "lossless-claw": {
      "enabled": true,
      "config": {
        "contextThreshold": 0.75,
        "freshTailCount": 24,
        "freshTailMaxTokens": 6000,
        "leafChunkTokens": 6000,
        "leafTargetTokens": 1600,
        "condensedTargetTokens": 1200,
        "maxAssemblyTokenBudget": 10240
      },
    }
  }
}
```

### Field Reference

#### context-trim

| Field | Value | Description |
|---|---|---|
| `enabled` | `true` | Enables the plugin. |
| `targets` | provider + model | Activates only for the specified provider/model pair — replace with your actual values. |
| `includeProjectContext` | `true` | Injects workspace files into the system prompt. |
| `perFileCharBudget` | `800` | Maximum characters retained from each project file. |
| `totalProjectCharBudget` | `2400` | Combined character cap across all project files. |
| `logging` | `true` | Emits a log line each time the plugin replaces the system prompt, useful for debugging. |

#### lossless-claw

| Field | Value | Description |
|---|---|---|
| `contextThreshold` | `0.75` | Triggers compaction when messages reach 75% × `maxAssemblyTokenBudget`. |
| `freshTailCount` | `24` | Protects the 24 most recent messages from compaction. |
| `freshTailMaxTokens` | `6000` | Token cap applied to the protected fresh tail. |
| `leafChunkTokens` | `6000` | When a leaf node exceeds this token count, a leaf compaction summary is generated. |
| `leafTargetTokens` | `1600` | Target size for leaf node summaries. |
| `condensedTargetTokens` | `1200` | Target size for non-leaf (condensed) summaries. |
| `maxAssemblyTokenBudget` | `10240` | Maximum tokens used per context assembly. |

---

## Configuration Example: 32K Models

### Full Configuration

```json
{
  "providers": {
    "your-provider": {
      "models": [
        {
          "id": "your-32k-model",
          "contextWindow": 32768
        }
      ]
    }
  },
  "plugins": {
    "allow": ["context-trim", "lossless-claw"],
    "slots": {
      "contextEngine": "lossless-claw"
    },
    "context-trim": {
      "enabled": true,
      "config": {
        "targets": [
          { "provider": "your-provider", "model": "your-32k-model" }
        ],
        "includeProjectContext": true,
        "perFileCharBudget": 1500,
        "totalProjectCharBudget": 5000,
        "skills": ["weather"],
        "logging": true
      },
    },
    "lossless-claw": {
      "enabled": true,
      "config": {
        "contextThreshold": 0.75,
        "freshTailCount": 28,
        "freshTailMaxTokens": 12000,
        "leafChunkTokens": 8000,
        "leafTargetTokens": 2000,
        "condensedTargetTokens": 1600,
        "maxAssemblyTokenBudget": 20480
      },
    }
  }
}
```

### Field Reference

#### context-trim

| Field | Value | Description |
|---|---|---|
| `enabled` | `true` | Enables the plugin. |
| `targets` | provider + model | Activates only for the specified provider/model pair — replace with your actual values. |
| `includeProjectContext` | `true` | Injects workspace files into the system prompt. |
| `perFileCharBudget` | `1500` | Maximum characters retained from each project file. |
| `totalProjectCharBudget` | `5000` | Combined character cap across all project files. |
| `skills` | `weather` | Skill whitelist — an array of skill names. |
| `logging` | `true` | Emits a log line each time the plugin replaces the system prompt, useful for debugging. |

#### lossless-claw

| Field | Value | Description |
|---|---|---|
| `contextThreshold` | `0.75` | Triggers compaction when messages reach 75% × `maxAssemblyTokenBudget`. |
| `freshTailCount` | `28` | Protects the 28 most recent messages from compaction. |
| `freshTailMaxTokens` | `12000` | Token cap applied to the protected fresh tail. |
| `leafChunkTokens` | `8000` | When a leaf node exceeds this token count, a leaf compaction summary is generated. |
| `leafTargetTokens` | `2000` | Target size for leaf node summaries. |
| `condensedTargetTokens` | `1600` | Target size for non-leaf (condensed) summaries. |
| `maxAssemblyTokenBudget` | `20480` | Maximum tokens used per context assembly. |
