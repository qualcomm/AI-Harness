// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export {
  buildChannelConfigSchema,
  TelegramConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
export {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./src/command-config.js";
