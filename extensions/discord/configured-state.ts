// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function hasDiscordConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.DISCORD_BOT_TOKEN === "string" &&
    params.env.DISCORD_BOT_TOKEN.trim().length > 0
  );
}
