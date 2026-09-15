/**
 * Tests for the trickiest piece: re-sensitizing a response stream, including
 * placeholders split across chunk boundaries.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { clearPiiMap, reSensitizeGlobal, setPiiMap } from "../src/pii-map-store.js";
import { reSensitizeChunk } from "../src/proxy.js";
import type { PiiItem } from "../src/types.js";

const ITEMS: PiiItem[] = [
  { placeholder: "⟦PII_aaaa1111⟧", original: "张伟", type: "NAME" },
  { placeholder: "⟦PII_bbbb2222⟧", original: "13912345678", type: "PHONE" },
];

describe("re-sensitization", () => {
  beforeEach(() => {
    clearPiiMap("s");
    setPiiMap("s", ITEMS);
  });

  test("restores placeholders in a single complete chunk", () => {
    const [emit, tail] = reSensitizeChunk("", "Dear ⟦PII_aaaa1111⟧, call ⟦PII_bbbb2222⟧.");
    expect(emit + tail).toBe("Dear 张伟, call 13912345678.");
  });

  test("handles a placeholder split across two chunks", () => {
    // Chunk 1 ends mid-placeholder.
    const [emit1, tail1] = reSensitizeChunk("", "Dear ⟦PII_aaa");
    // The partial placeholder must be held back, not emitted raw.
    expect(emit1).toBe("Dear ");
    expect(tail1).toContain("⟦PII_aaa");

    // Chunk 2 completes it.
    const [emit2, tail2] = reSensitizeChunk(tail1, "a1111⟧ hi");
    expect(emit1 + emit2 + tail2).toBe("Dear 张伟 hi");
  });

  test("global re-sensitize replaces all known placeholders", () => {
    expect(reSensitizeGlobal("⟦PII_aaaa1111⟧ / ⟦PII_bbbb2222⟧")).toBe("张伟 / 13912345678");
  });

  test("leaves text without placeholders untouched", () => {
    const [emit, tail] = reSensitizeChunk("", "just a normal sentence");
    expect(emit + tail).toBe("just a normal sentence");
  });
});
