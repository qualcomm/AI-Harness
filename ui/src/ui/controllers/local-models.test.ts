// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../gateway.ts";
import { loadLocalModelsStatus, type LocalModelsState } from "./local-models.ts";

function createState(overrides?: Partial<LocalModelsState>): LocalModelsState {
  return {
    client: null,
    connected: true,
    configSnapshot: null,
    applySessionKey: "main",
    localModelsStatus: null,
    localModelsStatusLoading: false,
    localModelsStatusError: null,
    localModelsCached: [],
    localModelsCachedLoading: false,
    localModelsCachedError: null,
    localModelsAvailable: [],
    localModelsAvailableLoading: false,
    localModelsAvailableError: null,
    localModelsChipset: null,
    localModelsChipsets: [],
    localModelsJobs: [],
    localModelsActionPending: false,
    localModelsActionMessage: null,
    localModelsSelectedAvailable: "",
    localModelsManualInput: "",
    ...overrides,
  };
}

describe("loadLocalModelsStatus", () => {
  it("treats geniex.status 'unknown method' as plugin-inactive, not an error", async () => {
    // This is the actual failure mode when geniex-manager has not loaded: the
    // config snapshot can never reflect it (auto-enable is never persisted to
    // disk), so the RPC's own error is the only reliable signal.
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: geniex.status",
      }),
    );
    const state = createState({ client: { request } as never });

    await loadLocalModelsStatus(state);

    expect(state.localModelsStatus).toEqual({ state: "plugin-inactive" });
    expect(state.localModelsStatusError).toBeNull();
  });

  it("does not mistake an unrelated unknown-method error for geniex being inactive", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "unknown method: other.thing" }),
    );
    const state = createState({ client: { request } as never });

    await loadLocalModelsStatus(state);

    expect(state.localModelsStatus).toBeNull();
    expect(state.localModelsStatusError).toContain("other.thing");
  });

  it("surfaces a real connection failure as an error, not as plugin-inactive", async () => {
    const request = vi.fn().mockRejectedValue(new Error("gateway not connected"));
    const state = createState({ client: { request } as never });

    await loadLocalModelsStatus(state);

    expect(state.localModelsStatus).toBeNull();
    expect(state.localModelsStatusError).toContain("gateway not connected");
  });

  it("sets the real status on success", async () => {
    const status = {
      state: "ready" as const,
      platform: "win32-arm64",
      cliPath: "C:/geniex/geniex.exe",
      baseUrl: "http://127.0.0.1:18181/v1",
      serve: { status: "running" as const },
    };
    const request = vi.fn().mockResolvedValue(status);
    const state = createState({ client: { request } as never });

    await loadLocalModelsStatus(state);

    expect(state.localModelsStatus).toEqual(status);
    expect(state.localModelsStatusError).toBeNull();
  });

  it("does nothing when not connected", async () => {
    const request = vi.fn();
    const state = createState({ client: { request } as never, connected: false });

    await loadLocalModelsStatus(state);

    expect(request).not.toHaveBeenCalled();
  });
});
