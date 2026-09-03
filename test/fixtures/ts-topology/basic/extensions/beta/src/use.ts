// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { sharedThing } from "fixture-sdk";
import type { SharedType } from "fixture-sdk";

export function betaUse(input: SharedType) {
  return `${sharedThing()}:${input.value}`;
}
