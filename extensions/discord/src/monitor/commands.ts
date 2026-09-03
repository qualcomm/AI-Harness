// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { DiscordSlashCommandConfig } from "openclaw/plugin-sdk/config-runtime";

export function resolveDiscordSlashCommandConfig(
  raw?: DiscordSlashCommandConfig,
): Required<DiscordSlashCommandConfig> {
  return {
    ephemeral: raw?.ephemeral !== false,
  };
}
