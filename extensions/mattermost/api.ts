// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Keep this barrel helper-only so plugin-sdk facades do not pull the full
// channel plugin (and its runtime state) into tests or other shared surfaces.
export { isMattermostSenderAllowed } from "./src/mattermost/monitor-auth.js";
