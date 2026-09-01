import { describe, expect, it } from "vitest";
import { wrapWebContent } from "../../security/external-content.js";
import {
  capWebSearchResult,
  DEFAULT_WEB_SEARCH_MAX_RESULT_CHARS,
  resolveWebSearchMaxResultChars,
} from "./web-search-result-cap.js";

function payloadOf(snippets: string[]): Record<string, unknown> {
  return {
    query: "河西走廊 国庆 自驾",
    provider: "tavily",
    count: snippets.length,
    tookMs: 2127,
    externalContent: { untrusted: true, source: "web_search", provider: "tavily", wrapped: true },
    results: snippets.map((snippet, i) => ({
      title: `结果 ${i}`,
      url: `https://example.com/${i}`,
      snippet,
      score: 0.9 - i * 0.1,
    })),
  };
}

const serialized = (p: unknown) => JSON.stringify(p, null, 2).length;
const resultsOf = (p: Record<string, unknown>) => p.results as Array<Record<string, unknown>>;

describe("resolveWebSearchMaxResultChars", () => {
  it("defaults when unset", () => {
    expect(resolveWebSearchMaxResultChars(undefined)).toBe(DEFAULT_WEB_SEARCH_MAX_RESULT_CHARS);
  });

  it("treats 0 and negatives as disabled", () => {
    expect(resolveWebSearchMaxResultChars(0)).toBe(0);
    expect(resolveWebSearchMaxResultChars(-1)).toBe(0);
  });

  // A malformed config must not silently remove the bound — an unbounded result is what
  // costs a context overflow, so the failure mode has to be "capped", not "unlimited".
  it("falls back to the default for non-numeric input rather than disabling", () => {
    expect(resolveWebSearchMaxResultChars("8000")).toBe(DEFAULT_WEB_SEARCH_MAX_RESULT_CHARS);
    expect(resolveWebSearchMaxResultChars(Number.NaN)).toBe(DEFAULT_WEB_SEARCH_MAX_RESULT_CHARS);
    expect(resolveWebSearchMaxResultChars(null)).toBe(DEFAULT_WEB_SEARCH_MAX_RESULT_CHARS);
  });

  it("floors fractional values", () => {
    expect(resolveWebSearchMaxResultChars(5000.7)).toBe(5000);
  });
});

describe("capWebSearchResult", () => {
  it("returns the payload by reference when it already fits", () => {
    const payload = payloadOf(["短摘要", "另一个短摘要"]);
    expect(capWebSearchResult(payload, 12000)).toBe(payload);
  });

  it("does nothing when capping is disabled", () => {
    const payload = payloadOf(["x".repeat(50000)]);
    expect(capWebSearchResult(payload, 0)).toBe(payload);
  });

  /**
   * The invariant that matters. A first implementation computed the budget arithmetically
   * from raw string lengths and overshot on 4 of these 5 shapes, because JSON escaping and
   * indentation inflate the serialized size by a content-dependent amount.
   */
  it.each([
    { name: "three large results", snippets: ["a".repeat(30000), "b".repeat(15000), "c".repeat(15000)], cap: 12000 },
    { name: "two very large results", snippets: ["a".repeat(40000), "b".repeat(40000)], cap: 8000 },
    { name: "one huge plus two small", snippets: ["a".repeat(60000), "b".repeat(400), "c".repeat(400)], cap: 9000 },
    { name: "CJK text, which escapes differently", snippets: ["正文".repeat(12000)], cap: 4000 },
    { name: "ten medium results", snippets: Array.from({ length: 10 }, () => "x".repeat(8000)), cap: 12000 },
  ])("brings $name under the cap", ({ snippets, cap }) => {
    const payload = payloadOf(snippets);
    expect(serialized(payload)).toBeGreaterThan(cap);
    expect(serialized(capWebSearchResult(payload, cap))).toBeLessThanOrEqual(cap);
  });

  // Undershooting wastes context that was already paid for, so the search converges up
  // toward the cap rather than stopping at the first candidate that happens to fit.
  it("uses most of the allowance rather than trimming far below it", () => {
    const capped = capWebSearchResult(payloadOf(["a".repeat(30000), "b".repeat(15000)]), 12000);
    expect(serialized(capped)).toBeGreaterThan(12000 * 0.85);
  });

  // Urls and titles are the citations: small, and the part still worth having once the
  // prose is gone.
  it("keeps urls, titles and scores whole", () => {
    const capped = capWebSearchResult(payloadOf(["a".repeat(40000), "b".repeat(40000)]), 8000);
    const results = resultsOf(capped);
    expect(results.map((r) => r.url)).toEqual(["https://example.com/0", "https://example.com/1"]);
    expect(results.map((r) => r.title)).toEqual(["结果 0", "结果 1"]);
    expect(results[0]!.score).toBe(0.9);
  });

  // Without this a model reading a cut-off snippet cannot tell it is a fragment.
  it("marks that truncation happened and reports the original size", () => {
    const payload = payloadOf(["a".repeat(30000)]);
    const capped = capWebSearchResult(payload, 5000);
    expect(capped.truncated).toBe(true);
    expect(capped.truncatedFromChars).toBe(serialized(payload));
    expect(JSON.stringify(capped)).toContain("truncated to fit the context window");
  });

  it("shares the budget so one huge result cannot starve the others", () => {
    const capped = capWebSearchResult(
      payloadOf(["a".repeat(60000), "b".repeat(400), "c".repeat(400)]),
      9000,
    );
    for (const r of resultsOf(capped)) {
      expect((r.snippet as string).length).toBeGreaterThan(100);
    }
  });

  it("truncates from the middle, keeping the lead and the tail", () => {
    const body = `${"HEAD".repeat(20)}${"m".repeat(30000)}${"TAIL".repeat(20)}`;
    const capped = capWebSearchResult(payloadOf([body]), 6000);
    const snippet = resultsOf(capped)[0]!.snippet as string;
    expect(snippet.startsWith("HEAD")).toBe(true);
    expect(snippet.endsWith("TAIL")).toBe(true);
    expect(snippet).toContain("truncated to fit the context window");
  });

  /**
   * The security case. Provider snippets arrive wrapped in untrusted-content markers; a
   * tail truncation drops the closing one and the model loses the boundary telling it
   * where attacker-controlled text ends.
   */
  it("preserves the untrusted-content markers", () => {
    const wrapped = wrapWebContent("正文".repeat(12000), "web_search");
    expect(wrapped).toContain("<<<END_EXTERNAL_UNTRUSTED_CONTENT");

    const snippet = resultsOf(capWebSearchResult(payloadOf([wrapped]), 4000))[0]!
      .snippet as string;
    expect(snippet.length).toBeLessThan(wrapped.length);
    expect(snippet).toMatch(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\s*$/);
    // Both halves of the pair survive, so the boundary is still well-formed.
    expect(snippet).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
  });

  /**
   * The documented exception: when the envelope plus markers already exceed the cap, the
   * markers win and the result comes back over budget. An unclosed wrapper would be worse
   * than an oversized one, and this only happens for caps far below any useful setting.
   */
  it("keeps the end marker even when that means exceeding the cap", () => {
    const wrapped = wrapWebContent("正文".repeat(12000), "web_search");
    const snippet = resultsOf(capWebSearchResult(payloadOf([wrapped]), 300))[0]!
      .snippet as string;
    expect(snippet).toMatch(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\s*$/);
    // Still vastly smaller than the input, just not under an unachievable cap.
    expect(snippet.length).toBeLessThan(wrapped.length / 10);
  });

  // Providers disagree on the field name: snippet (Tavily, DuckDuckGo), description
  // (Brave, Firecrawl), text (Exa). Enumerating them would miss the next one added.
  it("trims long text under any field name", () => {
    const payload = {
      query: "q",
      provider: "brave",
      results: [
        { url: "https://a.dev", description: "d".repeat(30000) },
        { url: "https://b.dev", text: "t".repeat(30000) },
      ],
    };
    const capped = capWebSearchResult(payload, 6000);
    expect((resultsOf(capped)[0]!.description as string).length).toBeLessThan(30000);
    expect((resultsOf(capped)[1]!.text as string).length).toBeLessThan(30000);
    expect(serialized(capped)).toBeLessThanOrEqual(6000);
  });

  it("reports an oversized envelope it cannot trim", () => {
    const payload = { query: "q".repeat(30000), provider: "tavily", results: [] };
    const capped = capWebSearchResult(payload, 1000);
    expect(capped.truncated).toBe(false);
    expect(capped.oversizeChars).toBe(serialized(payload));
  });

  it("leaves non-object entries alone", () => {
    const payload = { provider: "x", results: ["plain string", null, 42] };
    expect(capWebSearchResult(payload, 10).results).toEqual(["plain string", null, 42]);
  });

  it("does not mutate the input", () => {
    const payload = payloadOf(["a".repeat(30000)]);
    const before = JSON.stringify(payload);
    capWebSearchResult(payload, 5000);
    expect(JSON.stringify(payload)).toBe(before);
  });
});
