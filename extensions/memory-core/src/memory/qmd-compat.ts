// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type QmdCollectionPatternFlag = "--glob" | "--mask";

export function resolveQmdCollectionPatternFlags(
  preferredFlag: QmdCollectionPatternFlag | null,
): QmdCollectionPatternFlag[] {
  return preferredFlag === "--mask" ? ["--mask", "--glob"] : ["--glob", "--mask"];
}
