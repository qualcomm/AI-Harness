/**
 * Tests for resolveConfig's agentDescriptions handling — a hand-written map, so
 * malformed entries must be filtered rather than reaching formatKnownDomains.
 */

import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config-schema.js";

describe("resolveConfig agentDescriptions", () => {
  test("absent config yields an empty map", () => {
    expect(resolveConfig({}).agentDescriptions).toEqual({});
  });

  test("string entries are kept", () => {
    const cfg = resolveConfig({
      agentDescriptions: { coding: "负责代码编写与技术实现", research: "负责资料检索" },
    });
    expect(cfg.agentDescriptions).toEqual({
      coding: "负责代码编写与技术实现",
      research: "负责资料检索",
    });
  });

  test("blank and whitespace-only entries are dropped", () => {
    const cfg = resolveConfig({
      agentDescriptions: { coding: "负责代码", blank: "", spaces: "   " },
    });
    expect(cfg.agentDescriptions).toEqual({ coding: "负责代码" });
  });

  test("non-string entries are dropped", () => {
    const cfg = resolveConfig({
      agentDescriptions: { coding: "负责代码", num: 42, nested: { a: 1 }, nil: null },
    });
    expect(cfg.agentDescriptions).toEqual({ coding: "负责代码" });
  });

  // A bare string must not be walked by Object.entries: that splits it per
  // character and every entry would pass a value-only filter.
  test("a non-object agentDescriptions does not throw", () => {
    expect(resolveConfig({ agentDescriptions: "nonsense" }).agentDescriptions).toEqual({});
    expect(resolveConfig({ agentDescriptions: ["a", "b"] }).agentDescriptions).toEqual({});
    expect(resolveConfig({ agentDescriptions: 42 }).agentDescriptions).toEqual({});
    expect(resolveConfig({ agentDescriptions: null }).agentDescriptions).toEqual({});
  });
});

describe("resolveConfig maxVerifyRetries", () => {
  test("maxVerifyRetries defaults to 2 and honours an explicit 0", () => {
    expect(resolveConfig({}).maxVerifyRetries).toBe(2);
    expect(resolveConfig({ maxVerifyRetries: 0 }).maxVerifyRetries).toBe(0);
    expect(resolveConfig({ maxVerifyRetries: 5 }).maxVerifyRetries).toBe(5);
  });

  test("a non-numeric maxVerifyRetries falls back to the default", () => {
    expect(resolveConfig({ maxVerifyRetries: "3" }).maxVerifyRetries).toBe(2);
    expect(resolveConfig({ maxVerifyRetries: Number.NaN }).maxVerifyRetries).toBe(2);
  });
});
