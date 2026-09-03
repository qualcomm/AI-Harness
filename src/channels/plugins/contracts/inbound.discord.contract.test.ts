// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe } from "vitest";
import { installDiscordInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.discord.js";

describe("discord inbound contract", () => {
  installDiscordInboundContractSuite();
});
