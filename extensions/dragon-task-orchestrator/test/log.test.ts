import { describe, expect, test, vi } from "vitest";
import { logInfo } from "../src/log.js";

describe("logInfo", () => {
  test("does nothing when logging is off", () => {
    const info = vi.fn();
    logInfo(false, { info, warn: vi.fn() }, "should not appear");
    expect(info).not.toHaveBeenCalled();
  });

  test("does nothing when no logger is supplied", () => {
    expect(() => logInfo(true, undefined, "no logger")).not.toThrow();
  });

  test("prefixes the message and forwards it when logging is on", () => {
    const info = vi.fn();
    logInfo(true, { info, warn: vi.fn() }, "hello");
    expect(info).toHaveBeenCalledWith("[dragon-task-orchestrator] hello");
  });
});
