// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
} from "openclaw/plugin-sdk/skills-runtime";
import { buildAgentSystemPrompt } from "openclaw/plugin-sdk/system-prompt-runtime";

type ContextTrimTargetConfig = {
  provider?: string;
  model?: string;
};

type ResolvedContextTrimTargetConfig = {
  provider: string;
  model: string;
};

type ContextTrimPluginConfig = {
  enabled?: boolean;
  targets?: ContextTrimTargetConfig[];
  skills?: string[];
  includeProjectContext?: boolean;
  projectFiles?: string[];
  perFileCharBudget?: number;
  totalProjectCharBudget?: number;
  extraInstructions?: string;
  logging?: boolean;
};

type ResolvedContextTrimPluginConfig = {
  enabled: boolean;
  targets: ResolvedContextTrimTargetConfig[];
  skills: string[];
  includeProjectContext: boolean;
  projectFiles: string[];
  perFileCharBudget: number;
  totalProjectCharBudget: number;
  extraInstructions?: string;
  logging: boolean;
};

const DEFAULT_PER_FILE_CHAR_BUDGET = 500;
const DEFAULT_TOTAL_PROJECT_CHAR_BUDGET = 1_200;
const DEFAULT_PROJECT_FILES = ["AGENTS.md", "TOOLS.md"];

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizePositiveInt(value: unknown, fallback: number, min = 1, max = 1_000_000): number {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function normalizeTargets(value: unknown): ResolvedContextTrimTargetConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const record =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as ContextTrimTargetConfig)
          : undefined;
      const provider = normalizeProviderId(record?.provider);
      const model = normalizeOptionalString(record?.model);
      if (!provider || !model) {
        return undefined;
      }
      return { provider, model };
    })
    .filter((entry): entry is ResolvedContextTrimTargetConfig => Boolean(entry));
}

function normalizePluginConfig(pluginConfig: unknown): ResolvedContextTrimPluginConfig {
  const raw =
    pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
      ? (pluginConfig as ContextTrimPluginConfig)
      : {};
  return {
    enabled: raw.enabled !== false,
    targets: normalizeTargets(raw.targets),
    skills: normalizeStringList(raw.skills),
    includeProjectContext: raw.includeProjectContext !== false,
    projectFiles: normalizeStringList(raw.projectFiles).length
      ? normalizeStringList(raw.projectFiles)
      : DEFAULT_PROJECT_FILES,
    perFileCharBudget: normalizePositiveInt(
      raw.perFileCharBudget,
      DEFAULT_PER_FILE_CHAR_BUDGET,
      80,
      8_000,
    ),
    totalProjectCharBudget: normalizePositiveInt(
      raw.totalProjectCharBudget,
      DEFAULT_TOTAL_PROJECT_CHAR_BUDGET,
      200,
      20_000,
    ),
    extraInstructions: normalizeOptionalString(raw.extraInstructions),
    logging: raw.logging === true,
  };
}

function normalizeProviderId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function shouldEnableContextTrim(params: {
  cfg: OpenClawConfig;
  config: ResolvedContextTrimPluginConfig;
  providerId?: string;
  modelId?: string;
}): boolean {
  void params.cfg;
  if (!params.config.enabled) {
    return false;
  }

  const normalizedProvider = normalizeProviderId(params.providerId);
  const normalizedModel = params.modelId?.trim();
  if (!normalizedProvider || !normalizedModel) {
    return false;
  }

  return params.config.targets.some(
    (target) => target.provider === normalizedProvider && target.model === normalizedModel,
  );
}

function truncateAtBoundary(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const bounded = trimmed.slice(0, maxChars).trimEnd();
  const nextChar = trimmed.charAt(maxChars);
  if (!nextChar || /\s/.test(nextChar)) {
    return `${bounded}…`;
  }
  const lastBoundary = bounded.search(/\s\S*$/);
  if (lastBoundary > 0) {
    return `${bounded.slice(0, lastBoundary).trimEnd()}…`;
  }
  return `${bounded}…`;
}

function summarizeWorkspaceFile(text: string, maxChars: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"));
  const normalized = lines.join("\n");
  return truncateAtBoundary(normalized, maxChars);
}

async function buildProjectContextSummary(params: {
  workspaceDir?: string;
  config: ResolvedContextTrimPluginConfig;
}): Promise<string | undefined> {
  if (!params.config.includeProjectContext || !params.workspaceDir) {
    return undefined;
  }

  const sections: string[] = [];
  let remaining = params.config.totalProjectCharBudget;

  for (const fileName of params.config.projectFiles) {
    if (remaining <= 0) {
      break;
    }
    const filePath = path.join(params.workspaceDir, fileName);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const summary = summarizeWorkspaceFile(
        content,
        Math.min(params.config.perFileCharBudget, remaining),
      );
      if (!summary) {
        continue;
      }
      sections.push(`## ${fileName}\n${summary}`);
      remaining -= summary.length;
    } catch {
      continue;
    }
  }

  if (sections.length === 0) {
    return undefined;
  }

  return ["# Project Context", ...sections].join("\n\n");
}

function resolveConfiguredSkillsPrompt(params: {
  workspaceDir?: string;
  config: ResolvedContextTrimPluginConfig;
  runtimeConfig: OpenClawConfig;
}): string | undefined {
  if (!params.workspaceDir || params.config.skills.length === 0) {
    return undefined;
  }

  // only load skills that are explicitly configured
  const entries = loadWorkspaceSkillEntries(params.workspaceDir, {
    config: params.runtimeConfig,
    skillFilter: params.config.skills,
  });
  const skillsPrompt = resolveSkillsPromptForRun({
    workspaceDir: params.workspaceDir,
    config: params.runtimeConfig,
    entries,
  }).trim();

  return skillsPrompt || undefined;
}

async function buildCompactSystemPrompt(params: {
  workspaceDir?: string;
  providerId?: string;
  modelId?: string;
  toolNames?: string[];
  config: ResolvedContextTrimPluginConfig;
  runtimeConfig: OpenClawConfig;
}): Promise<string> {
  const skillsPrompt = resolveConfiguredSkillsPrompt({
    workspaceDir: params.workspaceDir,
    config: params.config,
    runtimeConfig: params.runtimeConfig,
  });

  // Use OpenClaw's own system prompt builder with minimal mode so the Tooling
  // section uses the real runtime tool list (filtered by policy) and the same
  // format the model already knows. This avoids maintaining a hardcoded tool list
  // that can drift from the actual available tools.
  const basePrompt = buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir ?? ".",
    toolNames: params.toolNames,
    promptMode: "minimal",
    skillsPrompt,
    runtimeInfo: {
      model:
        params.providerId && params.modelId
          ? `${params.providerId}/${params.modelId}`
          : undefined,
    },
  });

  const extras: string[] = [];

  const projectContextSummary = await buildProjectContextSummary({
    workspaceDir: params.workspaceDir,
    config: params.config,
  });
  if (projectContextSummary) {
    extras.push(projectContextSummary);
  }

  if (params.config.extraInstructions) {
    extras.push(`## Operator Instructions\n${params.config.extraInstructions}`);
  }

  if (extras.length === 0) {
    return basePrompt;
  }

  return [basePrompt, ...extras].join("\n\n");
}

export default definePluginEntry({
  id: "context-trim",
  name: "Context Trim",
  description:
    "Replaces the default system prompt with a compact prompt for low-context local or edge models.",
  register(api: OpenClawPluginApi) {
    let config = normalizePluginConfig(api.pluginConfig);

    const refreshLiveConfigFromRuntime = () => {
      const livePluginConfig =
        api.runtime.config.loadConfig().plugins?.entries?.["context-trim"]?.config ??
        api.pluginConfig;
      config = normalizePluginConfig(livePluginConfig);
    };

    api.on("before_prompt_build", async (_event, ctx) => {
      refreshLiveConfigFromRuntime();

      if (
        !shouldEnableContextTrim({
          cfg: api.runtime.config.loadConfig(),
          config,
          providerId: ctx.modelProviderId,
          modelId: ctx.modelId,
        })
      ) {
        return undefined;
      }

      const workspaceDir =
        ctx.workspaceDir ||
        (ctx.agentId
          ? resolveAgentWorkspaceDir(api.runtime.config.loadConfig(), ctx.agentId)
          : undefined);

      const runtimeConfig = api.runtime.config.loadConfig();
      const compactPrompt = await buildCompactSystemPrompt({
        workspaceDir,
        providerId: ctx.modelProviderId,
        modelId: ctx.modelId,
        toolNames: ctx.toolNames,
        config,
        runtimeConfig,
      });

      if (config.logging) {
        const nonLatinCount = (compactPrompt.match(/[⺀-鿿가-힯豈-﫿]/g) ?? []).length;
        const estimatedTokens = Math.ceil((compactPrompt.length + nonLatinCount * 3) / 4);
        api.logger.info?.(
          `context-trim: replaced system prompt for ${ctx.modelProviderId ?? "unknown"}/${ctx.modelId ?? "unknown"} (${compactPrompt.length} chars, ~${estimatedTokens} tokens)`,
        );
      }

      const dumpPath = (process.env.CONTEXT_TRIM_DUMP_FILE ?? "").trim();
      if (dumpPath) {
        try {
          const dumpDir = path.dirname(dumpPath);
          await fs.mkdir(dumpDir, { recursive: true });
          const payload = {
            generatedAt: new Date().toISOString(),
            provider: ctx.modelProviderId ?? null,
            model: ctx.modelId ?? null,
            workspaceDir: workspaceDir ?? null,
            chars: compactPrompt.length,
            systemPromptText: compactPrompt,
          };
          await fs.writeFile(dumpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
          if (config.logging) {
            api.logger.info?.(`context-trim: wrote system prompt dump to ${dumpPath}`);
          }
        } catch (err) {
          api.logger.warn?.(
            `context-trim: failed to write system prompt dump to ${dumpPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        systemPrompt: compactPrompt,
      };
    }, { priority: 10 });
  },
});
