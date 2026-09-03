// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { CronDelivery, CronJobCreate } from "../types.js";

export function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  if (input.sessionTarget === "isolated" && input.payload.kind === "agentTurn") {
    return { mode: "announce" };
  }
  return undefined;
}
