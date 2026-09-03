// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe } from "vitest";
import { installSlackInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.slack.js";

describe("slack inbound contract", () => {
  installSlackInboundContractSuite();
});
