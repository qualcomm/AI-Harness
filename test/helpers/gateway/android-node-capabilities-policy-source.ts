// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { GatewayConnectionDetails } from "../../../src/gateway/call.js";

export function shouldFetchRemotePolicyConfig(details: GatewayConnectionDetails): boolean {
  return details.urlSource !== "local loopback";
}
