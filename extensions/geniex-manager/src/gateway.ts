// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Gateway methods backing the Local Models UI.
 *
 * Read methods are `operator.read`; anything that downloads, deletes, or restarts
 * is `operator.write`.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { invalidateModelCatalog } from "openclaw/plugin-sdk/agent-runtime";
import { listAiHubChipsets, listAiHubModels } from "./aihub.js";
import { unallowlistRemovedModel } from "./allowlist.js";
import { type GenieXComputeUnit, isComputeUnitSelectable } from "./compute.js";
import {
  SELECTABLE_COMPUTE_UNITS,
  hasPrecisionOverride,
  readModelCompute,
  setModelCompute,
} from "./compute-config.js";
import {
  type GenieXCachedModel,
  listGenieXCachedModels,
  readGenieXChipset,
  removeGenieXModel,
  writeGenieXChipset,
} from "./model-store.js";
import type { GenieXPullJobManager } from "./pull-jobs.js";
import type { GenieXServeSupervisor } from "./serve-process.js";
import { resolveGenieXStatus } from "./status.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

function respondError(respond: GatewayRespond, error: unknown): void {
  respond(false, { error: error instanceof Error ? error.message : String(error) });
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Adds each model's configured compute unit, so the UI needs no config read. */
function withConfiguredCompute(
  api: OpenClawPluginApi,
  models: GenieXCachedModel[],
): Array<GenieXCachedModel & { compute: string; computeOverridden: boolean }> {
  const cfg = api.runtime.config.loadConfig();
  return models.map((model) => ({
    ...model,
    compute: readModelCompute(cfg, model.name) ?? "",
    // A hand-written `name:precision` entry wins over the bare-name one.
    computeOverridden: hasPrecisionOverride(cfg, model.name),
  }));
}

export function registerGenieXGatewayMethods(params: {
  api: OpenClawPluginApi;
  supervisor: GenieXServeSupervisor;
  pullJobs: GenieXPullJobManager;
}): void {
  const { api, supervisor, pullJobs } = params;

  // ── Status ───────────────────────────────────────────────────────────────
  api.registerGatewayMethod(
    "geniex.status",
    async ({ respond }) => {
      try {
        respond(
          true,
          await resolveGenieXStatus({
            baseUrl: supervisor.baseUrl,
            serve: supervisor.getState(),
          }),
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  // ── Serve lifecycle ──────────────────────────────────────────────────────
  api.registerGatewayMethod(
    "geniex.serve.start",
    async ({ respond }) => {
      try {
        respond(true, { serve: await supervisor.start() });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.serve.stop",
    async ({ respond }) => {
      try {
        await supervisor.stop();
        respond(true, { serve: supervisor.getState() });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.serve.restart",
    async ({ respond }) => {
      try {
        respond(true, { serve: await supervisor.restart() });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  // ── Cached models ────────────────────────────────────────────────────────
  api.registerGatewayMethod(
    "geniex.models.list",
    async ({ respond }) => {
      try {
        respond(true, { models: withConfiguredCompute(api, await listGenieXCachedModels()) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.models.remove",
    async ({ params: requestParams, respond }) => {
      try {
        const name = readRequiredString(requestParams, "name");
        await removeGenieXModel({ name });
        try {
          await unallowlistRemovedModel({ config: api.runtime.config, model: name, logger: api.logger });
        } catch (error) {
          // The model is already gone; a stale allowlist key is harmless.
          api.logger.warn(`GenieX allowlist cleanup failed: ${String(error)}`);
        }
        invalidateModelCatalog();
        respond(true, { models: withConfiguredCompute(api, await listGenieXCachedModels()) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  // Takes effect on the model's next request: the provider reads this config
  // when it builds each request body, so no restart is needed. GenieX keys its
  // loaded-model cache on the compute unit, so that request reloads the model.
  api.registerGatewayMethod(
    "geniex.models.setCompute",
    async ({ params: requestParams, respond }) => {
      try {
        const name = readRequiredString(requestParams, "name");
        const raw = readOptionalString(requestParams, "compute");
        // Empty / absent means "Default": drop the override.
        let compute: GenieXComputeUnit | undefined;
        if (raw) {
          if (!(SELECTABLE_COMPUTE_UNITS as readonly string[]).includes(raw)) {
            throw new Error(`compute must be one of ${SELECTABLE_COMPUTE_UNITS.join(", ")}.`);
          }
          compute = raw as GenieXComputeUnit;
        }

        const models = await listGenieXCachedModels();
        const model = models.find((entry) => entry.name === name);
        if (!model) {
          throw new Error(`"${name}" is not a downloaded model.`);
        }
        // NPU-only runtimes ignore the value; storing one would only mislead.
        if (!isComputeUnitSelectable(model.runtime)) {
          throw new Error(`"${name}" runs on the NPU only; its compute unit cannot be changed.`);
        }

        const next = setModelCompute(api.runtime.config.loadConfig(), name, compute);
        if (next) {
          await api.runtime.config.writeConfigFile(next);
        }
        respond(true, { models: withConfiguredCompute(api, models) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  // ── Downloadable models ──────────────────────────────────────────────────
  api.registerGatewayMethod(
    "geniex.models.available",
    async ({ params: requestParams, respond }) => {
      try {
        // An explicit chipset overrides the stored one; passing none lists every
        // model regardless of device compatibility.
        const explicitChipset = readOptionalString(requestParams, "chipset");
        const allChipsets = requestParams.allChipsets === true;
        const chipset = allChipsets ? undefined : (explicitChipset ?? (await readGenieXChipset()));
        respond(true, {
          chipset: chipset ?? null,
          models: await listAiHubModels(chipset ? { chipset } : undefined),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  // ── Chipset ──────────────────────────────────────────────────────────────
  api.registerGatewayMethod(
    "geniex.chipset.get",
    async ({ respond }) => {
      try {
        // null means "not resolved": GenieX could not autodetect and nothing is
        // stored, so the UI must ask before any AI Hub operation. Without this,
        // `geniex pull` would fall back to an interactive picker and hang.
        respond(true, { chipset: (await readGenieXChipset()) ?? null });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.chipset.list",
    async ({ respond }) => {
      try {
        respond(true, { chipsets: await listAiHubChipsets() });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.chipset.set",
    async ({ params: requestParams, respond }) => {
      try {
        await writeGenieXChipset({ chipset: readRequiredString(requestParams, "chipset") });
        respond(true, { chipset: (await readGenieXChipset()) ?? null });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  // ── Downloads ────────────────────────────────────────────────────────────
  api.registerGatewayMethod(
    "geniex.models.pull",
    async ({ params: requestParams, respond }) => {
      try {
        const model = readRequiredString(requestParams, "model");
        // AI Hub pulls resolve assets per chipset, and an unresolved chipset sends
        // `geniex pull` into its interactive picker — which would hang a non-TTY
        // child. Fail fast with actionable guidance instead.
        if (!(await readGenieXChipset())) {
          throw new Error(
            "No chipset is configured and none could be detected. Select a chipset before downloading.",
          );
        }
        respond(true, { job: pullJobs.start({ model }) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.models.pullJobs",
    async ({ respond }) => {
      try {
        respond(true, { jobs: pullJobs.list() });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.models.pullCancel",
    async ({ params: requestParams, respond }) => {
      try {
        const job = await pullJobs.cancel(readRequiredString(requestParams, "jobId"));
        if (!job) {
          throw new Error("Unknown download job.");
        }
        // "Paused", not "cancelled": GenieX keeps the partial download and the
        // next pull resumes from it.
        respond(true, { job });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "geniex.models.pullForget",
    async ({ params: requestParams, respond }) => {
      try {
        const jobId = readRequiredString(requestParams, "jobId");
        if (!pullJobs.forget(jobId)) {
          throw new Error("Unknown download job.");
        }
        // Return the full list so the client lands on gateway truth in one
        // round trip, matching `geniex.models.remove`.
        respond(true, { jobs: pullJobs.list() });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
