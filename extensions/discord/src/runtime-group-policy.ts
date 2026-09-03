// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Keep this shim tiny so api.ts can expose the runtime-group helper
// without pulling monitor/provider.ts into extension startup.
export { resolveOpenProviderRuntimeGroupPolicy as resolveDiscordRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
