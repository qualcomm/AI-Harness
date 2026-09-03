// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import {
  describeGithubCopilotProviderAuthContract,
  describeOpenAICodexProviderAuthContract,
} from "../../../test/helpers/plugins/provider-auth-contract.js";

describeOpenAICodexProviderAuthContract();
describeGithubCopilotProviderAuthContract();
