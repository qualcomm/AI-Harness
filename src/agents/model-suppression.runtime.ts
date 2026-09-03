// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { shouldSuppressBuiltInModel as shouldSuppressBuiltInModelImpl } from "./model-suppression.js";

type ShouldSuppressBuiltInModel =
  typeof import("./model-suppression.js").shouldSuppressBuiltInModel;

export function shouldSuppressBuiltInModel(
  ...args: Parameters<ShouldSuppressBuiltInModel>
): ReturnType<ShouldSuppressBuiltInModel> {
  return shouldSuppressBuiltInModelImpl(...args);
}
