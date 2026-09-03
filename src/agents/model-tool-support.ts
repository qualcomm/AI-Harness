// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function supportsModelTools(model: { compat?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsTools?: boolean })
      : undefined;
  return compat?.supportsTools !== false;
}
