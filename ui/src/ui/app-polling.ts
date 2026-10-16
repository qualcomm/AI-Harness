// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { DebugState } from "./controllers/debug.ts";
import { loadDebug } from "./controllers/debug.ts";
import type { LocalModelsState } from "./controllers/local-models.ts";
import { loadLocalModelsJobs } from "./controllers/local-models.ts";
import type { LogsState } from "./controllers/logs.ts";
import { loadLogs } from "./controllers/logs.ts";
import type { NodesState } from "./controllers/nodes.ts";
import { loadNodes } from "./controllers/nodes.ts";

type PollingHost = {
  localModelsPollInterval: number | null;
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  tab: string;
};

export function startLocalModelsPolling(host: PollingHost) {
  if (host.localModelsPollInterval != null) {
    return;
  }
  host.localModelsPollInterval = window.setInterval(() => {
    if (host.tab !== "localModels") {
      return;
    }
    void loadLocalModelsJobs(host as unknown as LocalModelsState);
  }, 1000);
}

export function stopLocalModelsPolling(host: PollingHost) {
  if (host.localModelsPollInterval == null) {
    return;
  }
  clearInterval(host.localModelsPollInterval);
  host.localModelsPollInterval = null;
}

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = window.setInterval(
    () => void loadNodes(host as unknown as NodesState, { quiet: true }),
    5000,
  );
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") {
      return;
    }
    void loadLogs(host as unknown as LogsState, { quiet: true });
  }, 2000);
}

export function stopLogsPolling(host: PollingHost) {
  if (host.logsPollInterval == null) {
    return;
  }
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") {
      return;
    }
    void loadDebug(host as unknown as DebugState);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}
