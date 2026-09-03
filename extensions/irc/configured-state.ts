// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function hasIrcConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.IRC_HOST === "string" &&
    params.env.IRC_HOST.trim().length > 0 &&
    typeof params.env?.IRC_NICK === "string" &&
    params.env.IRC_NICK.trim().length > 0
  );
}
