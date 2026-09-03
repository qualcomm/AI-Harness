// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag setup-only Slack surfaces into lightweight channel plugin loads.
export { slackPlugin } from "./src/channel.js";
