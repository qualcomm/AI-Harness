# Context Trim

[English Document](README.md)

一个 OpenClaw 插件，用于将默认系统提示词替换为精简版本，专为上下文窗口受限的本地或端侧模型设计。适用于上下文窗口小于 16K 的模型，在这类场景下 OpenClaw 完整系统提示词体积过大。

## 工作原理

在每次 `before_prompt_build` 事件触发时，插件检查当前的 provider/model 是否匹配已配置的 target。若匹配，则用基于 OpenClaw `minimal` 提示词模式构建的精简版本替换系统提示词，随后追加受字符预算限制的项目上下文摘要和额外指令。

插件以 **priority 10** 运行，优先级高于同样替换系统提示词的默认优先级（0）插件。

## minimal 与 full 模式对比

`minimal` 模式只保留工具调用 agent 所需的核心 section：

| 保留 | 去除 |
|---|---|
| Tooling（运行时过滤后的工具列表） | Memory（记忆系统） |
| Tool Call Style | Messaging / Voice |
| Safety | Assistant Output Directives |
| OpenClaw CLI Quick Reference | Silent Replies / Heartbeats |
| Skills（仅白名单中的 skill） | Execution Bias |
| Workspace | Model Aliases / Docs / Self-Update |
| Runtime | Authorized Senders |

典型的 minimal 提示词约为 **1,000–1,500 tokens**，而完整提示词通常超过 3,000 tokens。

## 安装

在 `openclaw.json` 的 `plugins.allow` 中添加 `context-trim`，并在 `plugins.entries` 中进行配置：

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

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 插件总开关。 |
| `targets` | `{ provider, model }[]` | `[]` | 触发精简提示词的 provider/model 组合，两个字段均须精确匹配（provider 不区分大小写）。 |
| `skills` | string[] | `[]` | 需要注入的 skill 名称白名单，只有列在此处的 skill 才会被加载。留空则不注入任何 skill。 |
| `includeProjectContext` | boolean | `true` | 是否追加精简的项目上下文 section。 |
| `projectFiles` | string[] | `["AGENTS.md", "TOOLS.md"]` | 需要摘要的工作区文件列表。 |
| `perFileCharBudget` | integer (80–8000) | `500` | 每个项目文件保留的最大字符数。 |
| `totalProjectCharBudget` | integer (200–20000) | `1200` | 所有项目文件的总字符上限。 |
| `extraInstructions` | string | — | 追加在项目上下文之后的额外运营指令（可选）。 |
| `logging` | boolean | `false` | 每次替换提示词时记录字符数和估算 token 数的日志。 |

### 完整配置示例

```json
{
  "plugins": {
    "entries": {
      "context-trim": {
        // openclaw控制插件是否加载
        "enabled": true,
        "config": {
          // 可选，默认为true
          "enabled": true,
          "targets": [
            { "provider": "openai-local", "model": "gpt-oss-20b" }
          ],
          "skills": ["weather", "calendar"],
          "includeProjectContext": true,
          "projectFiles": ["AGENTS.md", "TOOLS.md"],
          "perFileCharBudget": 400,
          "totalProjectCharBudget": 800,
          "extraInstructions": "除非用户使用其他语言，否则始终用中文回复。",
          "logging": true
        }
      }
    }
  }
}
```

## Skills 注入

Skills 通过**白名单**方式注入——只有 `skills` 数组中列出的 skill 才会被加载。这与 OpenClaw 默认行为不同，后者会全量加载工作区所有 skill。

Skill 的 `SKILL.md` frontmatter 中必须同时包含 `name` 和 `description` 字段。`name` 字段的值须与 `skills` 数组中的字符串完全一致（若 frontmatter 中没有 `name`，则以目录名作为 fallback）。

Skills 的搜索路径（优先级由低到高）：

1. `config.skills.load.extraDirs`（最低优先级）
2. OpenClaw 内置 skills
3. `~/.openclaw/skills`（managed）
4. `~/.agents/skills`（个人）
5. `{workspaceDir}/.agents/skills`（项目）
6. `{workspaceDir}/skills`（最高优先级）

若需从自定义目录加载 skill，在 `openclaw.json` 中配置 `skills.load.extraDirs`：

```json
{
  "skills": {
    "load": {
      "extraDirs": ["/path/to/your/skills"]
    }
  }
}
```

## 项目上下文摘要

当 `includeProjectContext` 开启时，插件会读取工作区目录下 `projectFiles` 指定的每个文件，去除空行和代码围栏，然后按词边界截断至 `perFileCharBudget` 字符。所有文件的总字符数进一步受 `totalProjectCharBudget` 约束。

最终生成一个紧凑的 `# Project Context` section，适合在有限的上下文窗口中使用。

## 调试

将环境变量 `CONTEXT_TRIM_DUMP_FILE` 设为文件路径，每次运行时将生成的系统提示词 dump 到磁盘：

```bash
CONTEXT_TRIM_DUMP_FILE=/tmp/context-trim-dump.json openclaw start
```

Dump 文件为 JSON 格式：

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

开启 `logging: true` 后，每次替换还会输出 info 日志：

```
context-trim: replaced system prompt for openai-local/gpt-oss-20b (6027 chars, ~1507 tokens)
```
## 适配8K模型的配置样例
### 完整配置
#### 1. 模型声明（声明 contextWindow）
openclaw 官方要求的最小 contextWindow 是 16K，如果小于16K会Block本次请求。
DragonClaw 通过下面配置，设置最小支持 8000 的 contextWindow。
```json
  "agents": {
    "defaults": {
      "contextWindowHardMin": 8000
    }
  }
```
显式声明你需要使用的模型的 contextWindow
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
#### 2. 插件配置

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
#### 关键参数说明

| 参数 | 值 | 说明 |
|---|---|---|
| `contextWindowHardMin` | `8000` | 覆盖默认硬性阈值 16000，允许 8K 模型通过 block 检查 |
| `contextWindow` | `8192` | 必须显式声明，否则框架默认 200,000，lossless-claw 永不触发压缩 |
| `contextThreshold` | `0.72` | 达到 72%（约 4096*0.72=2949 tokens）时触发压缩 |
| `freshTailCount` | `8` | 保留最近 8 条原始消息不压缩 |
| `leafChunkTokens` | `2000` | 每个叶节点摘要上限 |
| `includeProjectContext` | `false` | 8K 上下文关闭，节省 token，不会包含 workspace 下的 md 文件 |
| `maxAssemblyTokenBudget` | `4096` | 硬性限制单次组装的消息 token 上限 |
| `summaryModel` | `provider/model` | 该模型用于将用户历史对话总结为摘要 |

---
## 适配16K模型的配置样例
### 完整配置
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
      }
    }
  }
}
```
### 字段说明

#### context-trim

| 字段 | 值 | 说明 |
|---|---|---|
| `enabled` | `true` | 启用插件 |
| `targets` | provider + model | 仅对指定的 provider/model 激活，需替换为实际值 |
| `includeProjectContext` | `true` | 将工作区文件注入系统提示词 |
| `perFileCharBudget` | `800` | 每个项目文件最多保留 800 字符 |
| `totalProjectCharBudget` | `2400` | 所有项目文件合计上限 2400 字符 |
| `logging` | `true` | 插件替换系统提示时输出日志，便于调试 |

#### lossless-claw

| 字段 | 值 | 说明 |
|---|---|---|
| `contextThreshold` | `0.75` | 当消息达到 （75% × maxAssemblyTokenBudget）时触发压缩 |
| `freshTailCount` | `24` | 保护最近 24 条消息不被压缩 |
| `freshTailMaxTokens` | `6000` | 最近N条消息，每条消息不超过6000token |
| `leafChunkTokens` | `6000` | 叶节点消息超过这个值触发叶节点压缩生成摘要 |
| `leafTargetTokens` | `1600` | 叶节点生成的摘要大小 |
| `condensedTargetTokens` | `1200` | 非叶子节点生成的摘要大小 |
| `maxAssemblyTokenBudget` | `10240` | 决定每次组装最多用多少token |

## 适配32K模型的配置样例
### 完整配置
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
        "skills":["weather"],
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
#### context-trim
| 字段 | 值 | 说明 |
|---|---|---|
| `enabled` | `true` | 启用插件 |
| `targets` | provider + model | 仅对指定的 provider/model 激活，需替换为实际值 |
| `includeProjectContext` | `true` | 将工作区文件注入系统提示词 |
| `perFileCharBudget` | `1500` | 每个项目文件最多保留 800 字符 |
| `totalProjectCharBudget` | `5000` | 所有项目文件合计上限 2400 字符 |
| `skills` | `weather` | skill白名单，数组 |
| `logging` | `true` | 插件替换系统提示时输出日志，便于调试 |

#### lossless-claw
| 字段 | 值 | 说明 |
|---|---|---|
| `contextThreshold` | `0.75` | 当消息达到 （75% × maxAssemblyTokenBudget）时触发压缩 |
| `freshTailCount` | `10` | 保护最近 24 条消息不被压缩 |
| `freshTailMaxTokens` | `12000` | 最近N条消息，每条消息不超过12000token |
| `leafChunkTokens` | `8000` | 叶节点消息超过这个值触发叶节点压缩生成摘要 |
| `leafTargetTokens` | `2000` | 叶节点生成的摘要大小 |
| `condensedTargetTokens` | `1600` | 非叶子节点生成的摘要大小 |
| `maxAssemblyTokenBudget` | `10240` | 决定每次组装最多用多少token |
