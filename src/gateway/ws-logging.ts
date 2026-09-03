// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type GatewayWsLogStyle = "auto" | "full" | "compact";

let gatewayWsLogStyle: GatewayWsLogStyle = "auto";

export function setGatewayWsLogStyle(style: GatewayWsLogStyle): void {
  gatewayWsLogStyle = style;
}

export function getGatewayWsLogStyle(): GatewayWsLogStyle {
  return gatewayWsLogStyle;
}

export const DEFAULT_WS_SLOW_MS = 50;
