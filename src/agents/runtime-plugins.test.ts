import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUserPath } from "../utils.js";

const hoisted = vi.hoisted(() => ({
  resolveRuntimePluginRegistry: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn(),
  getActivePluginRegistry: vi.fn(),
  getActivePluginRuntimeSubagentMode: vi.fn(),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: hoisted.resolveRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: hoisted.resolvePluginRegistryLoadCacheKey,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: hoisted.getActivePluginRegistry,
  getActivePluginRuntimeSubagentMode: hoisted.getActivePluginRuntimeSubagentMode,
}));

const WORKSPACE = "/tmp/workspace";
/**
 * What the implementation actually forwards: `ensureRuntimePluginsLoaded` normalizes
 * the path first, and on Windows that turns "/tmp/workspace" into "C:\tmp\workspace".
 * Derived rather than hardcoded so these assertions hold on every platform.
 */
const RESOLVED_WORKSPACE = resolveUserPath(WORKSPACE);

const PARAMS = {
  config: {} as never,
  workspaceDir: WORKSPACE,
  allowGatewaySubagentBinding: true,
};

describe("ensureRuntimePluginsLoaded", () => {
  let ensureRuntimePluginsLoaded: typeof import("./runtime-plugins.js").ensureRuntimePluginsLoaded;

  beforeEach(async () => {
    hoisted.resolveRuntimePluginRegistry.mockReset();
    hoisted.resolveRuntimePluginRegistry.mockReturnValue(undefined);
    hoisted.resolvePluginRegistryLoadCacheKey.mockReset();
    hoisted.resolvePluginRegistryLoadCacheKey.mockReturnValue("key-a");
    hoisted.getActivePluginRegistry.mockReset();
    hoisted.getActivePluginRegistry.mockReturnValue({});
    hoisted.getActivePluginRuntimeSubagentMode.mockReset();
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("gateway-bindable");
    vi.resetModules();
    ({ ensureRuntimePluginsLoaded } = await import("./runtime-plugins.js"));
  });

  it("resolves runtime plugins through the shared runtime helper", async () => {
    ensureRuntimePluginsLoaded(PARAMS);

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: RESOLVED_WORKSPACE,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  // Regression: the gateway activates its registry with a richer option set, so this
  // caller's load key could never match the active one and EVERY call rebuilt every
  // plugin — ~27s before each embedded run start, 5+ times per decomposition turn.
  it("resolves once and then reuses, instead of rebuilding on every call", () => {
    ensureRuntimePluginsLoaded(PARAMS);
    ensureRuntimePluginsLoaded(PARAMS);
    ensureRuntimePluginsLoaded(PARAMS);

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
  });

  it("resolves again when the load key changes, so a config edit is still picked up", () => {
    ensureRuntimePluginsLoaded(PARAMS);
    hoisted.resolvePluginRegistryLoadCacheKey.mockReturnValue("key-b");
    ensureRuntimePluginsLoaded(PARAMS);

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(2);
  });

  it("resolves again when the gateway subagent binding was lost", () => {
    ensureRuntimePluginsLoaded(PARAMS);
    // Something else replaced the active registry without gateway binding — the exact
    // situation this function exists to repair.
    hoisted.getActivePluginRuntimeSubagentMode.mockReturnValue("default");
    ensureRuntimePluginsLoaded(PARAMS);

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(2);
  });

  it("resolves again when there is no active registry at all", () => {
    ensureRuntimePluginsLoaded(PARAMS);
    hoisted.getActivePluginRegistry.mockReturnValue(null);
    ensureRuntimePluginsLoaded(PARAMS);

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(2);
  });

  it("keys the memo on the resolved load options, not the raw params", () => {
    // workspaceDir is normalized before the key is computed, so two spellings of the
    // same path must not be treated as different load inputs.
    ensureRuntimePluginsLoaded(PARAMS);
    ensureRuntimePluginsLoaded({ ...PARAMS, workspaceDir: WORKSPACE });

    expect(hoisted.resolveRuntimePluginRegistry).toHaveBeenCalledTimes(1);
    expect(hoisted.resolvePluginRegistryLoadCacheKey).toHaveBeenCalledWith({
      config: {} as never,
      workspaceDir: RESOLVED_WORKSPACE,
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
  });
});
