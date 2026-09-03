// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const IOS_NODE = {
  nodeId: "ios-node",
  displayName: "iOS Node",
  remoteIp: "192.168.0.88",
  connected: true,
} as const;

export function createIosNodeListResponse(ts: number = Date.now()) {
  return {
    ts,
    nodes: [IOS_NODE],
  };
}
