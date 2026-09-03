// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe } from "vitest";
import { installSlackOutboundPayloadContractSuite } from "../../../../test/helpers/channels/outbound-payload-contract.js";

describe("slack outbound payload contract", () => {
  installSlackOutboundPayloadContractSuite();
});
