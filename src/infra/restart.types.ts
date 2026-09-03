// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type RestartAttempt = {
  ok: boolean;
  method: "launchctl" | "systemd" | "schtasks" | "supervisor";
  detail?: string;
  tried?: string[];
};
