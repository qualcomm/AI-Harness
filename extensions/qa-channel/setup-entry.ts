// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { qaChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(qaChannelPlugin);
