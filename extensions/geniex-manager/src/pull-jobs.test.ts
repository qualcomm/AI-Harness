// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { GenieXPullJobManager } from "./pull-jobs.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("GenieXPullJobManager", () => {
  it("rejects an invalid model name before spawning anything", () => {
    const manager = new GenieXPullJobManager(createLogger());
    expect(() => manager.start({ model: "a/b; rm -rf /" })).toThrow(/Invalid GenieX model name/);
  });

  it("rejects a blank model name", () => {
    const manager = new GenieXPullJobManager(createLogger());
    expect(() => manager.start({ model: "   " })).toThrow(/Invalid GenieX model name/);
  });

  it("reports no jobs before anything starts", () => {
    const manager = new GenieXPullJobManager(createLogger());
    expect(manager.list()).toEqual([]);
    expect(manager.get("missing")).toBeUndefined();
  });

  it("returns undefined when cancelling an unknown job", async () => {
    const manager = new GenieXPullJobManager(createLogger());
    await expect(manager.cancel("missing")).resolves.toBeUndefined();
  });

  it("finds no running job for a model that was never pulled", () => {
    const manager = new GenieXPullJobManager(createLogger());
    expect(manager.findRunningForModel("qualcomm/Qwen3-4B")).toBeUndefined();
  });

  it("surfaces a clear error when the CLI is absent", () => {
    // With no geniex on PATH the failure must be actionable, not an ENOENT
    // from deep inside spawn.
    const manager = new GenieXPullJobManager(createLogger());
    const previousPath = process.env.PATH;
    try {
      expect(() =>
        manager.start({ model: "qualcomm/Qwen3-4B", env: { PATH: "" } }),
      ).toThrow(/geniex CLI not found/);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("cancelAll resolves when there is nothing to cancel", async () => {
    const manager = new GenieXPullJobManager(createLogger());
    await expect(manager.cancelAll()).resolves.toBeUndefined();
  });
});
