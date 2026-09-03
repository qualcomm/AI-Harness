// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type ConnectedChannelStatusPatch = {
  connected: true;
  lastConnectedAt: number;
  lastEventAt: number;
};

export function createConnectedChannelStatusPatch(
  at: number = Date.now(),
): ConnectedChannelStatusPatch {
  return {
    connected: true,
    lastConnectedAt: at,
    lastEventAt: at,
  };
}
