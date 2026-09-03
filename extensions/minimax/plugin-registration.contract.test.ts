// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describePluginRegistrationContract } from "../../test/helpers/plugins/plugin-registration-contract.js";

describePluginRegistrationContract({
  pluginId: "minimax",
  providerIds: ["minimax", "minimax-portal"],
  speechProviderIds: ["minimax"],
  mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
  imageGenerationProviderIds: ["minimax", "minimax-portal"],
  videoGenerationProviderIds: ["minimax"],
  webSearchProviderIds: ["minimax"],
  requireDescribeImages: true,
  requireGenerateImage: true,
  requireGenerateVideo: true,
});
