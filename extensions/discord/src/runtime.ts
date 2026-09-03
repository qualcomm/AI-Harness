// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type DiscordChannelRuntime = {
  messageActions?: typeof import("./channel-actions.js").discordMessageActions;
  sendMessageDiscord?: typeof import("./send.js").sendMessageDiscord;
};

export type DiscordRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    discord?: DiscordChannelRuntime;
  };
};

const {
  setRuntime: setDiscordRuntime,
  tryGetRuntime: getOptionalDiscordRuntime,
  getRuntime: getDiscordRuntime,
} = createPluginRuntimeStore<DiscordRuntime>("Discord runtime not initialized");
export { getDiscordRuntime, getOptionalDiscordRuntime, setDiscordRuntime };
