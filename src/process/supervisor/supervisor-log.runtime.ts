// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("process/supervisor");

export function warnProcessSupervisorSpawnFailure(message: string) {
  log.warn(message);
}
