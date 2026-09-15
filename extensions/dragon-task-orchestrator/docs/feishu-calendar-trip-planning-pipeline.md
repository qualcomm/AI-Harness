# dragon-task-orchestrator 固定流水线：飞书日程 → 端云协同出行方案

## Context

用户想在 dragon-task-orchestrator 里做一个两步固定流水线（fixed pipeline）演示端云协同：

1. **Step 1（本地模型）**：读取用户的飞书日程，找到指定会议的时间/地点（例子：下周一 11:00，成都青羊区丰德成达中心）。
2. **Step 2（云端模型 deepseek-v4-flash）**：基于 Step 1 拿到的时间地点，规划怎么去——按需调用滴滴查路线/预估价，按需调用携程查机票/高铁/酒店，给用户出一份文字方案。

用户已确认三件事（通过 AskUserQuestion）：
- **本地模型**：还没部署，让我推荐一个开源模型，用户会部署在 Windows ARM64 上。
- **携程接入方式变了**：不是 MCP，是一个 skill —— `https://github.com/trips-ai/tripai-skill`。滴滴是真的 MCP（`https://mcp.didichuxing.com/api?tap=opt`），但鉴权方式/transport 类型未知，需要用户自己在滴滴开放平台确认后补全配置。
- **范围**：Step 2 只读研究 + 出文字方案，不调用下单类工具。
- **同城/跨城**：不预设，让模型自己根据日程里的地点判断要不要调携程。

本次探索确认的关键事实（均已读代码验证，不是猜测）：
- `AgentConfig`（`src/config/types.agents.ts`）每个 agent 都能单独设 `model`、`tools`（allow/deny/profile）、`skills`（allowlist）——这就是让 Step 1 用本地模型、Step 2 用云端模型，且各自只看到该看的工具/skill 的机制。这跟之前给 `video` agent 配 `tools.profile: "full"` + `tools.allow` 是同一套（顶层 `tools.profile: "coding"` 会把没显式放开的 agent 的工具收窄掉，必须每个新 agent 都带上 `profile: "full"`）。
- MCP 服务器在 `config.mcp.servers`（`src/config/types.mcp.ts`）里配置，支持 stdio（`command`+`args`）和 HTTP（`url`+`transport: "sse"|"streamable-http"`）两种。MCP 工具名规则是 `<serverName>__<toolName>`（`src/agents/pi-bundle-mcp-names.ts`），server 名和工具名里的非字母数字字符会被替换成 `-`。
- Skill 是文件形态，装在 `<workspaceDir>/skills/<name>/`（`src/agents/skills/workspace.ts`）。`openclaw skills install <slug>` 只认 ClawHub 注册表的 slug（`src/cli/skills-cli.ts`），装不了任意 GitHub 仓库——所以 `tripai-skill` 得手动 clone 进 workspace 的 skills 目录。
- 飞书官方有一个开源 MCP：`larksuite/lark-openapi-mcp`（npm 包 `@larksuiteoapi/lark-mcp`），自带 `preset.calendar.default` 预设（日历相关工具：`calendar.v4.calendarEvent.list/get/create/patch`、`calendar.v4.freebusy.list`、`calendar.v4.calendar.primary` 等）。读**个人**日历需要 `user_access_token`（不是只有 app_id/secret 就够），需要先跑一次性的 `lark-mcp login` 做 OAuth 授权。
- Fixed pipeline 不是写在 config 文件里的，是通过 `dragonTaskOrchestrator.pipelines.save` 这个 gateway RPC 方法落盘的（`extensions/dragon-task-orchestrator/index.ts`），用户之前跑通的"video search"流水线就是这么创建的——用户已经知道怎么操作这一步，计划里只需要给出两步的 `agentId`/`instruction` 内容。

## Step 1：本地模型 + 飞书日历

### 1a. 本地模型：Qwen3-4B-Instruct-2507（经 GenieX 部署）—— 已确认状态

实际部署的是 `qualcomm/Qwen3-4B-Instruct-2507:W4A16`（Qualcomm AI Hub 的 QAIRT 编译 bundle），通过 `geniex serve` 跑在目标机器的 `http://127.0.0.1:18190/v1`（端口是自己选的，不是默认的 18181）。

**关于工具调用支持，实测结论（不是猜测）**：
- 用裸 `messages: [{role: "user", ...}]` + `tools` 参数直接测，模型**不会**调用工具——返回 `finish_reason: "stop"`，`tool_calls: null`，模型直接用自然语言反问。
- 加一条明确写清楚 `<tool_call>{"name":...,"arguments":...}</tool_call>` 格式的 **system message** 之后，同一个模型才会正确触发工具调用——返回 `finish_reason: "tool_calls"`，`tool_calls[0].function` 里的 `name`/`arguments` 都正确。
- **结论**：这个 QAIRT bundle 的 chat template 不会仅凭 `tools` 参数自动学会怎么吐 tool call，必须在 system prompt 里把 `<tool_call>...</tool_call>` 的格式显式教一遍。`feishu-calendar` agent 的 `systemPromptOverride`（见 1d）已经按这个结论写了这句话进去，缺了这句会退化成纯文本瞎编（第一次真实跑 pipeline 时就踩过这个坑，模型直接编了一个不存在的会议）。
- 已知限制：单条回复只解析一个 tool call，不支持并行调用。

部署：

```bash
geniex pull ai-hub-models/Qwen3-4B-Instruct-2507
geniex serve --port 18190
```

### 1b. 注册为 OpenClaw 模型 provider —— 已写入配置

```json
"models": {
  "providers": {
    "geniex-local": {
      "baseUrl": "http://127.0.0.1:18190/v1",
      "auth": "api-key",
      "apiKey": "geniex",
      "api": "openai-completions",
      "models": [{ "id": "qualcomm/Qwen3-4B-Instruct-2507:W4A16", "name": "qwen3-4b-instruct" }]
    }
  }
}
```

```json
"agents": {
  "defaults": {
    "models": {
      "geniex-local/qualcomm/Qwen3-4B-Instruct-2507:W4A16": { "alias": "qwen3-4b-local" }
    }
  }
}
```

### 1c. 飞书日历读取 —— 放弃了 lark-mcp，改成 lark-cli + 自定义 Tool

原计划走 `@larksuiteoapi/lark-mcp` 的 MCP 路线，实际改成了飞书官方更新推荐的 `lark-cli`（`@larksuite/cli`）——它自己管 OAuth，不需要再单独走一遍 MCP 的授权流程。已经用 `lark-cli auth login` 认证过，并用 `lark-cli calendar +agenda --start 2026-09-10 --end 2026-10-10 --format json` 手动验证过能读到真实日程（包含 `location.address`/`location.name`/`vchat.meeting_url` 等完整字段）。

没有再走 MCP 包装（`lark-master-mcp` 之类），而是新建了一个独立扩展 `extensions/feishu-calendar/`，里面一个 Tool `feishu_calendar_agenda` 直接 `execFile` 调 `lark-cli calendar +agenda`、解析它的 JSON envelope（`{ok, data, error}`）。理由：`lark-cli` 已经做完认证，MCP 包装层只是多一层没必要的重复授权；自己封装还能拿到一个精确的工具名，不用等连上再猜 MCP 自动生成的名字。

相关文件：
- `extensions/feishu-calendar/src/feishu-calendar-exec.ts` —— `execFile` 包一层，处理 `ok:false` 时优先用 envelope 里的 `error.message`/`hint`。
- `extensions/feishu-calendar/src/feishu-calendar-agenda-tool.ts` —— Tool 定义，参数 `start`/`end`/`calendar_id` 全部可选。
- `extensions/feishu-calendar/openclaw.plugin.json` —— `configSchema` 只有一个可选的 `cliPath`（不填就假设 `lark-cli` 在 PATH 上）。

#### 踩过的三个坑（都已修，按出现顺序）

**坑 1：`spawn lark-cli ENOENT`**
`npm install -g @larksuite/cli` 在 Windows 上装出来的是 `lark-cli.cmd` 批处理 shim，不是真 `.exe`。`execFile` 不开 `shell` 时走 Windows 的 `CreateProcess`，它不像终端那样按 `PATHEXT` 补全后缀，裸名字找不到 shim。

**坑 2：补上 `.cmd` 后缀后变成 `spawn EINVAL`**
`CreateProcess` 根本不允许直接启动 `.cmd`/`.bat`，必须经过 `cmd.exe` 解释 —— 这是 Node 官方文档写明的限制，补后缀绕不过去。最终修法是在 `execFile` options 里加 `shell: process.platform === "win32"`，`args` 依然以数组传入（由 `cmd.exe` 自己转义，不是手拼字符串）。

**坑 3：`openclaw context detected but lark-cli is not bound to it`（identity 退化成 `bot`）**
这是 `lark-cli` 的 **workspace 隔离机制**（见其源码 `internal/core/workspace.go`）：它检测 `OPENCLAW_CLI` / `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR` 等环境变量，命中就把配置目录从 `~/.lark-cli/` 切换到 **`~/.lark-cli/openclaw/`**。

后果：在普通终端里跑 `lark-cli auth login` 拿到的 user token 属于 local workspace，**OpenClaw 通过 Tool 调用时完全看不到**，于是身份退化成 `bot`，而 bot 身份按官方文档明确说明「cannot access user resources like personal calendar / mail / drive」—— 读不到个人日历。

解决办法是在 openclaw workspace 里单独绑定+授权一次（见下方「验证方式」第 1 步）。这一步只能人工做，`lark-cli` 故意设了确认门槛：`config bind` 的 help 里写着「DO NOT bind without user confirmation」，因为 `--identity user-default` 意味着 AI 可以用用户身份操作飞书。

顺带修了我们自己的一个可观测性问题：`lark-cli` 的失败 envelope 写在 **stderr**（不是 stdout），且是多行 pretty-print 的 JSON。原来只读 stdout，导致这条错误在进度卡片里被截断成一个 `{`，完全看不出原因。现在 stderr 优先解析，并提取 `message`/`hint`。

### 1d. 新 agent：`feishu-calendar` —— 已写入配置

```json
{
  "id": "feishu-calendar",
  "model": { "primary": "qwen3-4b-local" },
  "systemPromptOverride": "你负责查询用户的飞书日程。根据指令里描述的时间范围/关键词，用 feishu_calendar_agenda 工具找到对应的日程，把会议的准确时间、完整地点（地址和名称）、主题原文告诉下一步——不要猜测、不要编造找不到的信息。你必须调用 feishu_calendar_agenda 工具，不能直接凭空回答。调用格式必须是：<tool_call>{\"name\": \"feishu_calendar_agenda\", \"arguments\": {\"start\": \"...\", \"end\": \"...\"}}</tool_call>",
  "tools": {
    "profile": "full",
    "allow": ["feishu_calendar_agenda"]
  }
}
```

**当前状态**：第一次接进完整 fixed pipeline 跑的时候，`systemPromptOverride` 还没加最后那句工具调用格式说明，模型直接编了一个不存在的会议（地址、会议室名字全是假的）——排查后确认是 1a 里说的那个 QAIRT bundle 的已知行为，加上格式说明后单独 curl 测过可以正常触发 `tool_calls`，**但加了这句之后还没有重新跑一次完整 pipeline 确认端到端生效**，下一步要做的就是这个。

## Step 2：云端模型 + 滴滴 MCP + 携程 skill

### 2a. 滴滴 MCP（占位，等你确认鉴权方式）

`https://mcp.didichuxing.com/api?tap=opt` 先按 HTTP MCP 占位写入 `mcp.servers`，**transport 类型和是否需要额外 Header（API Key）要你去滴滴开放平台文档/后台确认后再改**：

```json
"mcp": {
  "servers": {
    "didi": {
      "url": "https://mcp.didichuxing.com/api?tap=opt",
      "transport": "streamable-http"
    }
  }
}
```

`tools.allow` 只放**查询类**工具（路线、预估价、车型），不放下单/呼叫类工具——具体工具名同样要连上之后看一遍实际目录确认，不在这里预先瞪眼猜。

### 2b. 携程 skill（手动安装，不走 `skills install`）

```bash
git clone https://github.com/trips-ai/tripai-skill "<workspaceDir>/skills/tripai-skill"
```

装完用 `openclaw skills list` / `openclaw skills info tripai-skill` 确认实际注册的 skill id（clone 下来的目录名不一定就是最终 id，取决于它自己的 frontmatter 声明）。

### 2c. 新 agent：`trip-planner` —— 已写入配置，还有两处待确认

```json
{
  "id": "trip-planner",
  "systemPromptOverride": "你负责根据一个会议/行程的时间和地点，用 tripai-skill 规划怎么去。只做查询和方案输出，不调用任何下单/预订类操作，最终给用户一份包含可选交通方式、大致时间和费用的文字方案。",
  "skills": ["tripai-skill"],
  "tools": {
    "profile": "full",
    "allow": ["tavily_search", "tavily_extract"]
  }
}
```

没写 `model` 字段，直接继承 `agents.defaults.model.primary`（`deepseek/deepseek-v4-flash`）。

**两处待确认，不确认之前这个 agent 大概率跑不通**：
1. `skills: ["tripai-skill"]` 这个 id 是按 clone 目录名（`C:\Users\HCKTest\.openclaw\workspace\skills\tripai-skill`）猜的，需要跑 `openclaw skills list` 核对实际注册的 id。
2. `tools.allow` 里的 `tavily_search`/`tavily_extract` 是猜的——`tripai-skill` 的 `SKILL.md` 里教模型怎么用这个能力，具体依赖什么工具（网页搜索？直接 HTTP 调用？）要打开那份 `SKILL.md` 看一眼，跟 1a 的教训一样：skill 只是 prompt 层面的说明，工具权限跟它教的方法不匹配的话，说明是空的。

## 固定流水线两步

用创建"video search"流水线时用的同一个方式（Control UI 的流水线面板，或直接调 `dragonTaskOrchestrator.pipelines.save`），新建一条两步流水线：

```json
{
  "name": "会议出行规划",
  "steps": [
    {
      "agentId": "feishu-calendar",
      "instruction": "把【原始请求】里用户描述的会议关键词/时间范围，作为查询条件，找到对应的飞书日程。把会议的准确时间、完整地点、主题告诉下一步。"
    },
    {
      "agentId": "trip-planner",
      "instruction": "根据前面步骤输出里的会议时间和地点，判断是否需要跨城，规划交通方式并给出一份文字方案（不下单）。"
    }
  ]
}
```

## 进度小结（截至本次更新）

- ✅ `lark-cli` 认证完成，手动验证过能读到真实日程（含 `location`/`vchat`）。
- ✅ `feishu-calendar_agenda` Tool 已实现（`extensions/feishu-calendar/`），带测试。
- ✅ GenieX 本地模型部署完成（`qualcomm/Qwen3-4B-Instruct-2507:W4A16`，端口 18190），已确认工具调用**必须**配合 system prompt 里的 `<tool_call>` 格式说明才会触发。
- ✅ `feishu-calendar` agent 已写入 `agents.list`，`systemPromptOverride` 已按上面的实测结论加上格式说明。
- ✅ 工具调用链路已打通：加上 `<tool_call>` 格式说明后，模型确实调用了 `feishu_calendar_agenda` 并传对了 `start`/`end` 参数（日志确认）。
- ✅ Windows 上 `execFile` 跑不了 `.cmd` shim 的两个坑（ENOENT → EINVAL）已修（`shell: true`）。
- ⏳ **当前卡在这里**：`lark-cli` 的 workspace 隔离导致 openclaw 上下文里未绑定、身份退化成 `bot`，读不到个人日历（见「坑 3」）。修复需要在目标机器上人工跑一次 `config bind` + `auth login`，还没做。
- ⏳ `trip-planner` agent 已写入配置，`skills` id 和 `tools.allow` 都是猜的，待核对。
- ⏳ 滴滴 MCP 仍是占位配置，鉴权方式/transport 未确认。
- ⏳ 两步流水线（日历 → 出行规划）还没有创建/跑过，目前只跑过 `feishu-calendar` 单步流水线。

## 验证方式

本机（x64 开发机）不装 Windows ARM64 的本地模型也不跑 gateway，这部分只能在目标机器上验证：

1. **在 openclaw workspace 里绑定并授权 `lark-cli`**（见上面「坑 3」，只需做一次）。两条命令都要在带 OpenClaw 环境标记的 shell 里跑，否则又会落到 local workspace：

   ```cmd
   set OPENCLAW_CLI=1
   lark-cli config bind --source openclaw --identity user-default
   lark-cli auth login --recommend
   ```

   - `--identity user-default` 是**必须的**：`bot-only` 预设按官方说明读不到个人日历。代价是 AI 可以用你的飞书身份操作（读写文档、搜消息、改日程），官方警告是「不要把这个机器人分享给他人或拉进群聊」。
   - 如果 `config bind` 报需要 app id（多账号场景），补上 `--app-id cli_a9463e838b7c9bc6`。
   - 验证绑定成功：同一个 shell 里跑 `lark-cli auth status`，`identity` 应该是 `user` 而不是 `bot`。

2. **重新跑一次 `feishu-calendar` 单步流水线**，确认模型真的调用了 `feishu_calendar_agenda`（`gateway.log` 里有 `embedded run tool start ... tool=feishu_calendar_agenda`），并且报出的时间/地点跟 `lark-cli calendar +agenda` 手动查到的真实数据一致。
3. `openclaw skills list` 核对 `tripai-skill` 的实际 id，打开它的 `SKILL.md` 确认它依赖什么工具，回填 `trip-planner.tools.allow`。
4. 滴滴 MCP：去开放平台确认鉴权方式和 transport 类型，补全 `mcp.servers.didi` 配置，重启 gateway 后 `grep gateway.log` 确认连接成功，核对真实工具名回填 `trip-planner.tools.allow`。
5. 用创建"video search"流水线的同一个入口新建两步的"会议出行规划"流水线，在飞书日历里用一条真实（或手动建的测试）会议日程触发一次，检查：Step 1 是否准确报出时间地点（不编造）、Step 2 是否按会议地点自己判断了同城/跨城、最终方案里是否只有查询结果没有下单动作。
