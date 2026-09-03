// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import {
  describeImageWithModel,
  describeImagesWithModel,
  type MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";

export const anthropicMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "anthropic",
  capabilities: ["image"],
  defaultModels: { image: "claude-opus-4-6" },
  autoPriority: { image: 20 },
  nativeDocumentInputs: ["pdf"],
  describeImage: describeImageWithModel,
  describeImages: describeImagesWithModel,
};
