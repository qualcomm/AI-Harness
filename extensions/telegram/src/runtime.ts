// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
export type { TelegramChannelRuntime, TelegramRuntime } from "./runtime.types.js";
import type { TelegramRuntime } from "./runtime.types.js";

const {
  setRuntime: setTelegramRuntime,
  clearRuntime: clearTelegramRuntime,
  getRuntime: getTelegramRuntime,
} = createPluginRuntimeStore<TelegramRuntime>("Telegram runtime not initialized");
export { clearTelegramRuntime, getTelegramRuntime, setTelegramRuntime };
