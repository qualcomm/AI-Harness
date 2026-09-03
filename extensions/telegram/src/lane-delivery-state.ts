// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type LaneDeliverySnapshot = {
  delivered: boolean;
  skippedNonSilent: number;
  failedNonSilent: number;
};

export type LaneDeliveryStateTracker = {
  markDelivered: () => void;
  markNonSilentSkip: () => void;
  markNonSilentFailure: () => void;
  snapshot: () => LaneDeliverySnapshot;
};

export function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker {
  const state: LaneDeliverySnapshot = {
    delivered: false,
    skippedNonSilent: 0,
    failedNonSilent: 0,
  };
  return {
    markDelivered: () => {
      state.delivered = true;
    },
    markNonSilentSkip: () => {
      state.skippedNonSilent += 1;
    },
    markNonSilentFailure: () => {
      state.failedNonSilent += 1;
    },
    snapshot: () => ({ ...state }),
  };
}
