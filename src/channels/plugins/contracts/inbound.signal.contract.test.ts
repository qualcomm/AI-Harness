// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe } from "vitest";
import { installSignalInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.signal.js";

describe("signal inbound contract", () => {
  installSignalInboundContractSuite();
});
