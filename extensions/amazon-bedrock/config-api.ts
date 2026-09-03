// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Narrow barrel for config compatibility helpers consumed outside the plugin.
// Keep this separate from runtime exports so doctor/config code stays lightweight.

export { migrateAmazonBedrockLegacyConfig } from "./config-compat.js";
