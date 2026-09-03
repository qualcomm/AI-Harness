// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Compatibility bridge for plugin-sdk context-engine symbols.
 *
 * This module intentionally exports only stable plugin-sdk surface area.
 */

export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  IngestBatchResult,
  BootstrapResult,
  SubagentSpawnPreparation,
  SubagentEndReason,
} from "openclaw/plugin-sdk";

export {
  registerContextEngine,
  type ContextEngineFactory,
} from "openclaw/plugin-sdk";
