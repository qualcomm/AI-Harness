// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};
