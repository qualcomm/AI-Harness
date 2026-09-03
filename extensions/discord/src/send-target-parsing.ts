// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import {
  parseDiscordTarget,
  type DiscordTarget,
  type DiscordTargetParseOptions,
} from "./target-parsing.js";

export type SendDiscordTarget = DiscordTarget;

export type SendDiscordTargetParseOptions = DiscordTargetParseOptions;

export const parseDiscordSendTarget = (
  raw: string,
  options: SendDiscordTargetParseOptions = {},
): SendDiscordTarget | undefined => parseDiscordTarget(raw, options);
