// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Private runtime barrel for the bundled Microsoft Teams extension.
// Keep this barrel thin and aligned with the local extension surface.

export * from "openclaw/plugin-sdk/msteams";
export { setMSTeamsRuntime } from "./src/runtime.js";
