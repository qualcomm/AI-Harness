// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "qwen",
  providerIds: ["qwen"],
  mediaUnderstandingProviderIds: ["qwen"],
  videoGenerationProviderIds: ["qwen"],
  requireDescribeImages: true,
  requireGenerateVideo: true,
});
