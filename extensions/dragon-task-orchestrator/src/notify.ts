/**
 * Best-effort out-of-band chat notification.
 *
 * `before_agent_reply` can only return a single reply (see hooks.ts D3), so
 * "real-time" progress/PRD notices cannot travel through that return value.
 * This module bypasses it the same way `extensions/device-pair/notify.ts`'s
 * `notifySubscriber` does: resolve where this session was last delivered to,
 * then push text directly through `api.runtime.channel.outbound`.
 *
 * Every failure mode here (no session entry, no delivery target, adapter
 * missing, send throwing) must resolve to `false` rather than throwing — the
 * final `summarize()` reply is the only delivery guarantee this plugin makes;
 * this channel is strictly best-effort on top of it.
 */

import { resolveSessionStoreEntry } from "openclaw/plugin-sdk/config-runtime";
import { truncate } from "./sanitize.js";
import type { Logger } from "./runtime-contract.js";
import type { SubtaskPlan, SubtaskResult } from "./types.js";

/** Per-subtask description budget in the PRD notice — a listing, not the full brief. */
const PRD_DESCRIPTION_CHARS = 120;

/**
 * Only the delivery-route fields this module reads. The host's real `SessionEntry`
 * carries required bookkeeping (`sessionId`, `updatedAt`) that is irrelevant here
 * and is not exported from plugin-sdk, so the store argument type is derived from
 * the function that consumes it rather than restated.
 */
type SessionEntryLike = {
  deliveryContext?: { channel?: string; to?: string; accountId?: string; threadId?: string | number };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

type SessionStoreArg = Parameters<typeof resolveSessionStoreEntry>[0]["store"];

type SendTextParams = {
  cfg: unknown;
  to: string;
  text: string;
  accountId?: string;
  threadId?: string | number;
};

export type NotifyApi = {
  config: { session?: { store?: string } };
  runtime: {
    agent: {
      session: {
        resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
        loadSessionStore: (storePath: string) => Record<string, unknown>;
      };
    };
    channel: {
      outbound: {
        loadAdapter: (
          channelId: string,
        ) => Promise<{ sendText?: (params: SendTextParams) => Promise<unknown> } | undefined>;
      };
    };
  };
  logger?: Logger;
};

/** Resolve `{channel, to, accountId?, threadId?}` from the last known route on `sessionKey`. */
function resolveDeliveryTarget(
  entry: SessionEntryLike | undefined,
): { channel: string; to: string; accountId?: string; threadId?: string | number } | undefined {
  const channel = entry?.deliveryContext?.channel ?? entry?.lastChannel;
  const to = entry?.deliveryContext?.to ?? entry?.lastTo;
  if (!channel || !to) return undefined;
  const accountId = entry?.deliveryContext?.accountId ?? entry?.lastAccountId;
  const threadId = entry?.deliveryContext?.threadId ?? entry?.lastThreadId;
  return { channel, to, ...(accountId ? { accountId } : {}), ...(threadId != null ? { threadId } : {}) };
}

/**
 * Send `text` to whatever chat channel `sessionKey` was last delivered on.
 * Returns `true` only on a confirmed send; any resolution/send failure
 * returns `false` silently (logged at warn, never thrown).
 */
export async function sendChannelNotice(
  api: NotifyApi,
  sessionKey: string,
  agentId: string,
  text: string,
): Promise<boolean> {
  try {
    const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
      agentId,
    });
    const store = api.runtime.agent.session.loadSessionStore(storePath);
    const entry = resolveSessionStoreEntry({ store: store as SessionStoreArg, sessionKey })
      .existing as SessionEntryLike | undefined;
    const target = resolveDeliveryTarget(entry);
    if (!target) return false;

    const adapter = await api.runtime.channel.outbound.loadAdapter(target.channel);
    if (!adapter?.sendText) return false;

    await adapter.sendText({
      cfg: api.config,
      to: target.to,
      text,
      ...(target.accountId ? { accountId: target.accountId } : {}),
      ...(target.threadId != null ? { threadId: target.threadId } : {}),
    });
    return true;
  } catch (e) {
    api.logger?.warn(
      `[dragon-task-orchestrator] channel notice failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * PRD notice: the decomposition result plus who each subtask went to.
 *
 * Rendered from the already-resolved `agentIdOf` map rather than re-deriving it,
 * because resolution runs real classifier model calls (see pipeline.ts
 * `resolveAgentsFor`).
 */
export function formatPrdNotice(
  subtasks: SubtaskPlan[],
  agentIdOf: Map<number, string>,
  defaultAgentId: string,
): string {
  const lines = subtasks.map((s, i) => {
    const agentId = agentIdOf.get(s.id) ?? defaultAgentId;
    const criteria = s.acceptanceCriteria?.trim();
    const label = s.title.trim() || truncate(s.description, PRD_DESCRIPTION_CHARS);
    const deps =
      s.needsPriorResults && s.needsPriorResults.length > 0
        ? `（依赖：${s.needsPriorResults.join("、")}）`
        : "";
    return `${i + 1}. ${label}${deps} → 分配给：${agentId}（${criteria ? `校验点：${truncate(criteria, PRD_DESCRIPTION_CHARS)}` : "无校验"}）`;
  });
  return [`【任务拆解】共 ${subtasks.length} 个子任务：`, ...lines].join("\n");
}

/**
 * Notice sent when every subtask is done and summarizing is about to start.
 *
 * Summarizing is the last stage and a slow one (136s measured, 17% of the request),
 * during which the card already shows all subtasks finished — so without this the
 * user sees a completed-looking view and no answer for minutes.
 *
 * Failures are named here rather than left for the summary, because this notice may
 * be the only thing a user sees for a while and "3 done" would be a lie when one of
 * them failed.
 */
export function formatSummarizingNotice(results: SubtaskResult[]): string {
  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.length - ok;
  const tail = failed > 0 ? `（${ok} 项成功、${failed} 项失败）` : `（共 ${ok} 项）`;
  return `【整合中】所有子任务已执行完毕${tail}，正在整合成最终回复，请稍候…`;
}

/** Per-layer progress notice. `layerResults` covers only the layer just finished. */
export function formatLayerProgressNotice(
  done: number,
  total: number,
  layerResults: SubtaskResult[],
): string {
  const head = `【执行进度】第 ${done}/${total} 层已完成`;
  if (layerResults.length === 0) return head;
  const items = layerResults.map(
    (r) => `${r.agentId}#${r.id} ${r.status === "ok" ? "✅" : "❌"}`,
  );
  return `${head}：${items.join(" / ")}`;
}
