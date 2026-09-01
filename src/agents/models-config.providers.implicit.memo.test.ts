/**
 * Catalog-probe memo and bounded-concurrency probing.
 *
 * These two changes exist to remove a measured 338s (of a 660s orchestration run) spent
 * inside `ensureOpenClawModelsJson`. The memo is the part that must be provably correct
 * rather than merely fast: a key that is too loose serves a stale catalog after a
 * credential changes, which is a wrong answer, not a slow one.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const runProviderCatalog = vi.hoisted(() => vi.fn());

vi.mock("../plugins/provider-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-discovery.js")>();
  return {
    ...actual,
    // One fake provider in the "simple" order, so exactly one probe runs per pass and the
    // call count is a direct measure of cache behaviour.
    resolvePluginDiscoveryProviders: vi.fn(async () => [
      { id: "fake", discoveryOrder: "simple" },
    ]),
    groupPluginDiscoveryProvidersByOrder: (providers: unknown[]) => ({
      simple: providers,
      profile: [],
      paired: [],
      late: [],
    }),
    normalizePluginDiscoveryResult: () => ({ fake: { baseUrl: "https://fake.test" } }),
    runProviderCatalog,
  };
});

const { resetImplicitProvidersMemoForTest, resolveImplicitProviders } = await import(
  "./models-config.providers.implicit.js"
);

function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "openclaw-memo-test-"));
}

const BASE_ENV = { VITEST: "1", NODE_ENV: "test" } satisfies NodeJS.ProcessEnv;

beforeEach(() => {
  resetImplicitProvidersMemoForTest();
  runProviderCatalog.mockReset();
  runProviderCatalog.mockResolvedValue({ models: [{ id: "m1" }] });
});

describe("catalog probe memo", () => {
  test("probes once and reuses the result for an identical call", async () => {
    const agentDir = freshAgentDir();
    const first = await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    const second = await resolveImplicitProviders({ agentDir, env: BASE_ENV });

    expect(runProviderCatalog).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  /**
   * The whole point. Before this memo, each pass could return a slightly different model
   * list, which changed models.json's contents, which changed its mtime, which invalidated
   * the write fingerprint — so the next call re-probed. 10 of 15 calls rewrote the file.
   */
  test("a second call does not re-probe even when the provider would answer differently", async () => {
    const agentDir = freshAgentDir();
    runProviderCatalog.mockResolvedValueOnce({ models: [{ id: "m1" }] });
    runProviderCatalog.mockResolvedValueOnce({ models: [{ id: "m1" }, { id: "m2" }] });

    const first = await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    const second = await resolveImplicitProviders({ agentDir, env: BASE_ENV });

    expect(runProviderCatalog).toHaveBeenCalledTimes(1);
    // Identical output is what keeps models.json stable and stops the rewrite loop.
    expect(second).toEqual(first);
  });

  test("a different agentDir is a different key", async () => {
    await resolveImplicitProviders({ agentDir: freshAgentDir(), env: BASE_ENV });
    await resolveImplicitProviders({ agentDir: freshAgentDir(), env: BASE_ENV });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
  });

  /**
   * env is not derivable from config and is not optional in the key: it carries API keys,
   * the discovery filter and the probe timeout. Keying without it would serve a cached
   * catalog after a key was exported — a stale answer.
   */
  test("a changed env re-probes", async () => {
    const agentDir = freshAgentDir();
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    await resolveImplicitProviders({
      agentDir,
      env: { ...BASE_ENV, SOME_PROVIDER_API_KEY: "added-later" },
    });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
  });

  /**
   * The key covers only the config branches the probes read. A first attempt keyed on the
   * WHOLE config, which turned "probe once per machine" into "probe once per agent": each
   * agent resolves its own `systemPromptOverride`/`tools`/`workspace`, giving 7 distinct
   * keys for 15 calls in the measured run, none of those fields reaching a catalog.
   */
  test.each([
    ["models", { models: { providers: { openai: { baseUrl: "https://a.test" } } } }],
    ["secrets", { secrets: { defaults: { provider: "env" } } }],
    ["plugins", { plugins: { allow: ["openai"] } }],
  ])("a changed %s branch re-probes", async (_name, config) => {
    const agentDir = freshAgentDir();
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    await resolveImplicitProviders({ agentDir, env: BASE_ENV, config: config as never });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["agents", { agents: { defaults: { subagents: { maxConcurrent: 8 } } } }],
    ["tools", { tools: { profile: "coding" } }],
    ["channels", { channels: { feishu: { enabled: true } } }],
  ])("a changed %s branch does NOT re-probe", async (_name, config) => {
    const agentDir = freshAgentDir();
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    await resolveImplicitProviders({ agentDir, env: BASE_ENV, config: config as never });
    // These never reach a provider catalog, so keying on them only multiplies the work.
    expect(runProviderCatalog).toHaveBeenCalledTimes(1);
  });

  // Adding or refreshing a credential must take effect without a restart.
  test("a touched auth-profiles.json re-probes", async () => {
    const agentDir = freshAgentDir();
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    writeFileSync(join(agentDir, "auth-profiles.json"), JSON.stringify({ profiles: {} }), "utf8");
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
  });

  test("explicitProviders participates in the key", async () => {
    const agentDir = freshAgentDir();
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    await resolveImplicitProviders({
      agentDir,
      env: BASE_ENV,
      explicitProviders: { openai: { baseUrl: "https://x.test" } } as never,
    });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
  });

  /**
   * The failure mode a single-slot memo would have: a main agent and its subagents differ
   * by config shape, so alternating between them would miss every time — leaving the cost
   * exactly where it was while looking like a cache had been added.
   */
  test("alternating between two configs still hits, rather than thrashing", async () => {
    const agentDir = freshAgentDir();
    const configA = undefined;
    // Differs in a branch the probes DO read, so these are genuinely two keys.
    const configB = { models: { providers: { openai: { baseUrl: "https://b.test" } } } } as never;

    await resolveImplicitProviders({ agentDir, env: BASE_ENV, config: configA });
    await resolveImplicitProviders({ agentDir, env: BASE_ENV, config: configB });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2); // two cold keys

    // Four more alternating calls must add no probes at all.
    for (const config of [configA, configB, configA, configB]) {
      await resolveImplicitProviders({ agentDir, env: BASE_ENV, config });
    }
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
  });

  // The key embeds config and env, so an unbounded map would be a slow leak in a
  // long-running gateway.
  test("keeps the entry count bounded", async () => {
    const agentDir = freshAgentDir();
    for (let i = 0; i < 40; i++) {
      await resolveImplicitProviders({
        agentDir,
        env: { ...BASE_ENV, UNIQUE_PER_CALL: String(i) },
      });
    }
    expect(runProviderCatalog).toHaveBeenCalledTimes(40);
    // Re-requesting the most recent key must still hit — eviction took the oldest.
    await resolveImplicitProviders({
      agentDir,
      env: { ...BASE_ENV, UNIQUE_PER_CALL: "39" },
    });
    expect(runProviderCatalog).toHaveBeenCalledTimes(40);
  });

  /**
   * Cache stampede. Observed at 23:39:14 and 23:39:27 in the measured run: both logged
   * `entries=3` because neither had inserted yet, so a ~25s pass ran twice for one answer.
   * The entry now holds the in-flight promise, registered before the first await.
   */
  test("concurrent callers with the same key share one probe", async () => {
    const agentDir = freshAgentDir();
    let release: (v: unknown) => void = () => {};
    runProviderCatalog.mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );

    const a = resolveImplicitProviders({ agentDir, env: BASE_ENV });
    const b = resolveImplicitProviders({ agentDir, env: BASE_ENV });
    // Let both reach the memo before either settles.
    await new Promise((r) => setTimeout(r, 5));
    release({ models: [{ id: "m1" }] });

    expect(await a).toEqual(await b);
    expect(runProviderCatalog).toHaveBeenCalledTimes(1);
  });

  /**
   * A rejected pass must not be cached. Leaving the rejected promise in place would replay
   * one transient network error to every caller for the whole TTL — 15 minutes of broken
   * provider discovery from a single blip.
   */
  test("a failed probe is not cached", async () => {
    const agentDir = freshAgentDir();
    runProviderCatalog.mockRejectedValueOnce(new Error("network blip"));

    await expect(resolveImplicitProviders({ agentDir, env: BASE_ENV })).rejects.toThrow(
      "network blip",
    );
    // The retry must actually re-probe rather than replay the failure.
    const recovered = await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
    expect(recovered).toBeDefined();
  });

  // A TTL shorter than the workload it covers buys nothing: the first attempt used 2
  // minutes against a ~20 minute run, so the same agent re-probed 9 minutes later.
  test("the TTL outlasts a long orchestration run", async () => {
    const { CATALOG_MEMO_TTL_MS } = (
      await import("./models-config.providers.implicit.js")
    ).__testing;
    expect(CATALOG_MEMO_TTL_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  test("the reset hook clears the memo", async () => {
    const agentDir = freshAgentDir();
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    resetImplicitProvidersMemoForTest();
    await resolveImplicitProviders({ agentDir, env: BASE_ENV });
    expect(runProviderCatalog).toHaveBeenCalledTimes(2);
  });
});

const { mapWithConcurrency, PROVIDER_CATALOG_PROBE_CONCURRENCY } = (
  await import("./models-config.providers.implicit.js")
).__testing;

/**
 * The probes became concurrent, but MERGING stayed sequential and in input order, because
 * `mergeImplicitProviderConfig` reads the accumulator as it goes: when two providers
 * contribute the same id, the winner depends on merge order. If results came back in
 * completion order, provider precedence would depend on network latency.
 */
describe("mapWithConcurrency", () => {
  test("returns results in input order, not completion order", async () => {
    const delays = [40, 5, 25, 1];
    const out = await mapWithConcurrency(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:40", "1:5", "2:25", "3:1"]);
  });

  test("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually concurrent, not accidentally serial
  });

  test("runs every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 8, async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test("handles an empty list without spawning workers", async () => {
    expect(await mapWithConcurrency([], 8, async () => "x")).toEqual([]);
  });

  test("a limit above the item count is clamped", async () => {
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
  });

  // A rejecting probe must not be swallowed into a silently short result set.
  test("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("probe failed");
        return n;
      }),
    ).rejects.toThrow("probe failed");
  });

  test("the configured concurrency is bounded, not unlimited", () => {
    expect(PROVIDER_CATALOG_PROBE_CONCURRENCY).toBeGreaterThan(1);
    expect(PROVIDER_CATALOG_PROBE_CONCURRENCY).toBeLessThanOrEqual(16);
  });
});
