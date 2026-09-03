// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { UpdateAvailable } from "../infra/update-startup.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};
