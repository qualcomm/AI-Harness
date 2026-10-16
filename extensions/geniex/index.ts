// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { isGenieXCliAvailable } from "./src/cli.js";
import { normalizeGenieXPluginConfig } from "./src/config.js";
import {
  GENIEX_DEFAULT_API_KEY_ENV_VAR,
  GENIEX_PROVIDER_ID,
  GENIEX_PROVIDER_LABEL,
} from "./src/defaults.js";
import { normalizeGenieXProviderConfig } from "./src/models.js";
import { resolveGenieXPlatformSupport } from "./src/platform.js";
import { wrapGenieXModelLoadOptions } from "./src/stream.js";

/** Lazily loads setup helpers so provider wiring stays lightweight at startup. */
async function loadProviderSetup() {
  return await import("./api.js");
}

export default definePluginEntry({
  id: GENIEX_PROVIDER_ID,
  name: "GenieX Provider",
  description: "On-device inference on Qualcomm Snapdragon via GenieX",
  register(api: OpenClawPluginApi) {
    // Per-model settings are edited at runtime (Local Models tab), so they are
    // re-read for each request rather than frozen at registration.
    const readPluginConfig = () =>
      normalizeGenieXPluginConfig(
        api.runtime.config.loadConfig().plugins?.entries?.[GENIEX_PROVIDER_ID]?.config,
      );

    // Editing `models` must not restart the gateway: core treats every
    // `plugins.*` change as a restart, but these settings are only read when a
    // request is built, so nothing needs to be re-applied.
    api.registerReload({
      noopPrefixes: [`plugins.entries.${GENIEX_PROVIDER_ID}.config.models`],
    });

    // Auto-enable only where GenieX can actually run. The platform check is pure
    // memory access, so hosts that can never run GenieX pay nothing; only ARM64
    // hosts go on to touch the filesystem looking for the CLI.
    //
    // This is a provider-only plugin — see extensions/geniex-manager for the
    // `geniex serve` process supervision and the `geniex.*` gateway methods
    // (status, model downloads, chipset config). That plugin's own manifest
    // declares no provider, so core treats it as a startup sidecar and loads
    // it unconditionally at boot; this plugin declares `providers: ["geniex"]`
    // and is instead resolved lazily when a chat request needs a GenieX model.
    // Both auto-enable independently using the same criteria below.
    api.registerAutoEnableProbe(() => {
      const platform = resolveGenieXPlatformSupport();
      if (!platform.supported) {
        return null;
      }
      return isGenieXCliAvailable() ? "geniex CLI detected on PATH" : null;
    });

    api.registerProvider({
      id: GENIEX_PROVIDER_ID,
      label: GENIEX_PROVIDER_LABEL,
      docsPath: "/providers/geniex",
      envVars: [GENIEX_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: GENIEX_PROVIDER_LABEL,
          hint: "Local on-device inference via geniex serve",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureGenieXInteractive({
              config: ctx.config,
              prompter: ctx.prompter,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureGenieXNonInteractive(ctx);
          },
        },
      ],
      discovery: {
        // Run after the hosted providers so a local GenieX instance does not
        // dominate model resolution.
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverGenieXProvider(ctx);
        },
      },
      // GenieX serves an unauthenticated local API, so synthesize the standard
      // local marker instead of collecting a credential.
      resolveSyntheticAuth: () => ({
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        source: "models.providers.geniex (synthetic local key)",
        mode: "api-key" as const,
      }),
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
      normalizeConfig: ({ providerConfig }) => normalizeGenieXProviderConfig(providerConfig),
      // Injects the model's configured compute unit (and llama_cpp nctx / ngl)
      // into each request body, which is how per-model compute works against a
      // single long-running `geniex serve`.
      wrapStreamFn: (ctx) => wrapGenieXModelLoadOptions({ ctx, getPluginConfig: readPluginConfig }),
      wizard: {
        setup: {
          choiceId: GENIEX_PROVIDER_ID,
          choiceLabel: GENIEX_PROVIDER_LABEL,
          choiceHint: "On-device inference on Qualcomm Snapdragon",
          groupId: GENIEX_PROVIDER_ID,
          groupLabel: GENIEX_PROVIDER_LABEL,
          groupHint: "Local NPU / GPU / CPU inference",
          methodId: "custom",
        },
        modelPicker: {
          label: "GenieX (on-device)",
          hint: "Detect models from geniex serve /v1/models",
          methodId: "custom",
        },
      },
      buildUnknownModelHint: () =>
        "GenieX models are discovered from a running `geniex serve` instance. " +
        "Start it with `geniex serve`, then download a model with `geniex pull <model>`. " +
        "See: https://docs.openclaw.ai/providers/geniex",
    });
  },
});
