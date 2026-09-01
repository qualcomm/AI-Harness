/**
 * Tests for the best-effort out-of-band notifier and the PRD / progress text it
 * carries. The delivery guarantee lives in the final summarized reply, so every
 * failure mode here must degrade to `false` rather than throw.
 */

import { describe, expect, test, vi } from "vitest";
import {
  formatLayerProgressNotice,
  formatPrdNotice,
  formatSummarizingNotice,
  sendChannelNotice,
  type NotifyApi,
} from "../src/notify.js";
import type { SubtaskPlan, SubtaskResult } from "../src/types.js";

type StoreEntry = Record<string, unknown>;

/** Build a NotifyApi whose session store contains exactly `entries`. */
function makeApi(params: {
  entries: Record<string, StoreEntry>;
  sendText?: (p: unknown) => Promise<unknown>;
  adapterMissing?: boolean;
  throwOnLoadStore?: boolean;
}): { api: NotifyApi; sendText: ReturnType<typeof vi.fn> } {
  const sendText = vi.fn(params.sendText ?? (async () => ({ messageId: "1" })));
  const api = {
    config: { session: { store: undefined } },
    runtime: {
      agent: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => {
            if (params.throwOnLoadStore) throw new Error("store unreadable");
            return params.entries;
          }),
        },
      },
      channel: {
        outbound: {
          loadAdapter: vi.fn(async () =>
            params.adapterMissing ? undefined : { sendText },
          ),
        },
      },
    },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as NotifyApi;
  return { api, sendText };
}

describe("sendChannelNotice", () => {
  test("sends to the last known route recorded on the session", async () => {
    const { api, sendText } = makeApi({
      entries: {
        "agent:main:default": {
          deliveryContext: { channel: "telegram", to: "123", accountId: "acct", threadId: 7 },
        },
      },
    });

    const ok = await sendChannelNotice(api, "agent:main:default", "main", "进度");
    expect(ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ to: "123", text: "进度", accountId: "acct", threadId: 7 }),
    );
  });

  test("falls back to the legacy lastChannel/lastTo fields", async () => {
    const { api, sendText } = makeApi({
      entries: { "agent:main:default": { lastChannel: "feishu", lastTo: "u1" } },
    });

    const ok = await sendChannelNotice(api, "agent:main:default", "main", "进度");
    expect(ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ to: "u1", text: "进度" }));
  });

  test("returns false without sending when the session has no known route", async () => {
    const { api, sendText } = makeApi({ entries: { "agent:main:default": {} } });
    expect(await sendChannelNotice(api, "agent:main:default", "main", "进度")).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  test("returns false when the session is absent from the store", async () => {
    const { api, sendText } = makeApi({ entries: {} });
    expect(await sendChannelNotice(api, "agent:main:never-seen", "main", "进度")).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  test("a channel with no outbound adapter degrades to false", async () => {
    const { api } = makeApi({
      entries: { "agent:main:default": { lastChannel: "webchat", lastTo: "u1" } },
      adapterMissing: true,
    });
    expect(await sendChannelNotice(api, "agent:main:default", "main", "进度")).toBe(false);
  });

  test("a throwing sendText is swallowed, not propagated", async () => {
    const { api } = makeApi({
      entries: { "agent:main:default": { lastChannel: "telegram", lastTo: "u1" } },
      sendText: async () => {
        throw new Error("network down");
      },
    });
    expect(await sendChannelNotice(api, "agent:main:default", "main", "进度")).toBe(false);
  });

  test("an unreadable session store is swallowed, not propagated", async () => {
    const { api } = makeApi({ entries: {}, throwOnLoadStore: true });
    expect(await sendChannelNotice(api, "agent:main:default", "main", "进度")).toBe(false);
  });
});

describe("formatPrdNotice", () => {
  const subtasks: SubtaskPlan[] = [
    { id: 0, title: "查资料", description: "查资料" },
    { id: 1, title: "写代码", description: "写代码", needsPriorResults: [0], acceptanceCriteria: "覆盖单测" },
  ];

  test("lists every subtask with its assigned agent and verification point", () => {
    const text = formatPrdNotice(
      subtasks,
      new Map([
        [0, "research"],
        [1, "coding"],
      ]),
      "default",
    );
    expect(text).toContain("共 2 个子任务");
    expect(text).toContain("查资料");
    expect(text).toContain("research");
    expect(text).toContain("校验点：覆盖单测");
    // research has no acceptance criteria.
    expect(text).toContain("无校验");
    expect(text).toContain("（依赖：0）");
  });

  test("unresolved subtasks are shown against the default agent", () => {
    const text = formatPrdNotice(subtasks, new Map(), "default");
    expect(text).toContain("default");
  });
});

describe("formatSummarizingNotice", () => {
  // This notice may be the only thing a user sees for the ~2 minutes summarizing takes,
  // so it must not claim a clean sweep when a subtask failed.
  test("reports a plain total when everything succeeded", () => {
    const results: SubtaskResult[] = [
      { id: 0, agentId: "coding", text: "t", status: "ok", processingNotices: [] },
      { id: 1, agentId: "research", text: "t", status: "ok", processingNotices: [] },
    ];
    const text = formatSummarizingNotice(results);
    expect(text).toContain("整合中");
    expect(text).toContain("共 2 项");
    expect(text).not.toContain("失败");
  });

  test("names the failures instead of glossing over them", () => {
    const results: SubtaskResult[] = [
      { id: 0, agentId: "coding", text: "t", status: "ok", processingNotices: [] },
      { id: 1, agentId: "research", text: "", status: "error", error: "超时" },
    ];
    const text = formatSummarizingNotice(results);
    expect(text).toContain("1 项成功");
    expect(text).toContain("1 项失败");
  });

  test("tells the user to wait, which is the whole point of the notice", () => {
    const results: SubtaskResult[] = [
      { id: 0, agentId: "coding", text: "t", status: "ok", processingNotices: [] },
    ];
    expect(formatSummarizingNotice(results)).toMatch(/稍候|稍等/);
  });
});

describe("formatLayerProgressNotice", () => {
  test("marks ok and error results distinctly", () => {
    const results: SubtaskResult[] = [
      { id: 0, agentId: "coding", text: "t", status: "ok", processingNotices: [] },
      { id: 1, agentId: "research", text: "", status: "error", error: "boom" },
    ];
    const text = formatLayerProgressNotice(1, 3, results);
    expect(text).toContain("第 1/3 层已完成");
    expect(text).toContain("coding#0 ✅");
    expect(text).toContain("research#1 ❌");
  });

  test("an empty layer still reports its position", () => {
    expect(formatLayerProgressNotice(2, 2, [])).toContain("第 2/2 层已完成");
  });
});
