// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe } from "vitest";
import { installTelegramInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.telegram.js";

describe("telegram inbound contract", () => {
  installTelegramInboundContractSuite();
});
