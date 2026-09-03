// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { readStringParam } from "../runtime-api.js";

export function readDiscordParentIdParam(
  params: Record<string, unknown>,
): string | null | undefined {
  if (params.clearParent === true) {
    return null;
  }
  if (params.parentId === null) {
    return null;
  }
  return readStringParam(params, "parentId");
}
