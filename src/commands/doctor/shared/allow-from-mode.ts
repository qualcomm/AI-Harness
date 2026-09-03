// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { AllowFromMode } from "./allow-from-mode.types.js";

export type { AllowFromMode } from "./allow-from-mode.types.js";

export function resolveAllowFromMode(channelName: string): AllowFromMode {
  return getDoctorChannelCapabilities(channelName).dmAllowFromMode;
}
