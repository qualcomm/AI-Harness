// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe } from "vitest";
import { installDiscordOutboundPayloadContractSuite } from "../../../../test/helpers/channels/outbound-payload-contract.js";

describe("discord outbound payload contract", () => {
  installDiscordOutboundPayloadContractSuite();
});
