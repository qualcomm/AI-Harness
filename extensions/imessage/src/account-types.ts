// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export type IMessageAccountConfig = Omit<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>,
  "accounts" | "defaultAccount"
>;
