/**
 * Regression tests for double-encoded local-model JSON outputs that previously
 * parsed to an empty array silently (0 PII redacted despite the model finding
 * PII) because literal `\n` inside the string survived `unescapeQuotes` and
 * broke `JSON.parse`.
 */

import { describe, expect, test } from "vitest";
import { normalizeModelText, unescapeQuotes } from "../src/parse-helpers.js";

describe("unescapeQuotes", () => {
  test("unescapes quotes and backslashes", () => {
    expect(unescapeQuotes('{\\"level\\":\\"S2\\"}')).toBe('{"level":"S2"}');
  });

  test("unescapes literal \\n into a real newline", () => {
    expect(unescapeQuotes("[\\n  1\\n]")).toBe("[\n  1\n]");
  });

  test("unescapes literal \\r and \\t", () => {
    expect(unescapeQuotes("a\\rb\\tc")).toBe("a\rb\tc");
  });
});

describe("normalizeModelText — double-encoded PII extraction outputs", () => {
  test("markdown-fenced + double-encoded array with literal \\n and \\\" parses as valid JSON", () => {
    const raw =
      '```json\\n[\\n    {\\"type\\": \\"NAME\\", \\"value\\": \\"张伟\\"},\\n    {\\"type\\": \\"EMAIL\\", \\"value\\": \\"1232321323767@163.com\\"}\\n]\\n```';
    const normalized = normalizeModelText(raw);
    const start = normalized.indexOf("[");
    const end = normalized.lastIndexOf("]");
    const parsed = JSON.parse(normalized.slice(start, end + 1));
    expect(parsed).toEqual([
      { type: "NAME", value: "张伟" },
      { type: "EMAIL", value: "1232321323767@163.com" },
    ]);
  });

  test("double-encoded single-item array with literal \\n parses as valid JSON", () => {
    const raw = '```json\\n[\\n  {\\"type\\": \\"EMAIL\\", \\"value\\": \\"1232321323767@163.com\\"}\\n]\\n```';
    const normalized = normalizeModelText(raw);
    const start = normalized.indexOf("[");
    const end = normalized.lastIndexOf("]");
    const parsed = JSON.parse(normalized.slice(start, end + 1));
    expect(parsed).toEqual([{ type: "EMAIL", value: "1232321323767@163.com" }]);
  });

  test("plain (non-double-encoded) array still parses unchanged", () => {
    const raw = '[{"type":"EMAIL","value":"1232321323767@163.com"}]';
    const normalized = normalizeModelText(raw);
    const parsed = JSON.parse(normalized);
    expect(parsed).toEqual([{ type: "EMAIL", value: "1232321323767@163.com" }]);
  });
});
