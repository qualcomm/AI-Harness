// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { listTasksForAgentId, listTasksForSessionKey } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

export function listTasksForSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTasksForSessionKey(sessionKey);
}

export function listTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return listTasksForAgentId(agentId);
}
