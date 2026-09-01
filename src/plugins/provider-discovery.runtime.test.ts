import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "./types.js";

const resolvePluginProvidersMock = vi.fn<() => ProviderPlugin[]>();

// The entry fast path needs a manifest carrying `providerDiscoverySource`; with none,
// resolution falls through to the plugin loader, which is the expensive path this
// module memoizes.
vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));
vi.mock("./providers.js", () => ({
  resolveDiscoveredProviderPluginIds: () => [] as string[],
}));
vi.mock("./providers.runtime.js", () => ({
  resolvePluginProviders: () => resolvePluginProvidersMock(),
}));

const { resetPluginDiscoveryProvidersMemoForTest, resolvePluginDiscoveryProvidersRuntime } =
  await import("./provider-discovery.runtime.js");

function makeProvider(id: string): ProviderPlugin {
  return { id, label: id, auth: [], catalog: { run: async () => null } };
}

function configWith(providerId: string): OpenClawConfig {
  return { models: { providers: { [providerId]: { baseUrl: "http://127.0.0.1/v1", models: [] } } } } as OpenClawConfig;
}

describe("resolvePluginDiscoveryProvidersRuntime memoization", () => {
  beforeEach(() => {
    resetPluginDiscoveryProvidersMemoForTest();
    resolvePluginProvidersMock.mockReset().mockImplementation(() => [makeProvider("alpha")]);
  });

  it("loads once and reuses the result for identical inputs", () => {
    const params = { config: configWith("alpha"), workspaceDir: "/ws", onlyPluginIds: ["alpha"] };

    const first = resolvePluginDiscoveryProvidersRuntime(params);
    const second = resolvePluginDiscoveryProvidersRuntime(params);

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("reuses across distinct-but-equal params objects", () => {
    // This is the case that matters in production: every agent's embedded run builds
    // its own params object, so identity-based caching would never hit.
    resolvePluginDiscoveryProvidersRuntime({ config: configWith("alpha"), workspaceDir: "/ws" });
    resolvePluginDiscoveryProvidersRuntime({ config: configWith("alpha"), workspaceDir: "/ws" });

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("ignores onlyPluginIds ordering, which the loader treats as a set", () => {
    resolvePluginDiscoveryProvidersRuntime({ onlyPluginIds: ["alpha", "beta"] });
    resolvePluginDiscoveryProvidersRuntime({ onlyPluginIds: ["beta", "alpha"] });

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("reloads when the config changes", () => {
    resolvePluginDiscoveryProvidersRuntime({ config: configWith("alpha") });
    resolvePluginDiscoveryProvidersRuntime({ config: configWith("beta") });

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("reloads when the plugin scope changes", () => {
    resolvePluginDiscoveryProvidersRuntime({ onlyPluginIds: ["alpha"] });
    resolvePluginDiscoveryProvidersRuntime({ onlyPluginIds: ["alpha", "beta"] });

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("caches an empty result rather than retrying the expensive load", () => {
    // No providers discovered is a legitimate steady state (all plugins disabled);
    // retrying would pay the full load on every embedded run for nothing.
    resolvePluginProvidersMock.mockImplementation(() => []);

    expect(resolvePluginDiscoveryProvidersRuntime({ workspaceDir: "/ws" })).toEqual([]);
    expect(resolvePluginDiscoveryProvidersRuntime({ workspaceDir: "/ws" })).toEqual([]);
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });
});
