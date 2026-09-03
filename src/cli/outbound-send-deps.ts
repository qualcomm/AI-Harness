// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { OutboundSendDeps } from "../infra/outbound/send-deps.js";
import type { CliDeps } from "./deps.types.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

export type { CliDeps } from "./deps.types.js";

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
