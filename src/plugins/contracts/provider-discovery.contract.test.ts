// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import {
  describeCloudflareAiGatewayProviderDiscoveryContract,
  describeGithubCopilotProviderDiscoveryContract,
  describeMinimaxProviderDiscoveryContract,
  describeModelStudioProviderDiscoveryContract,
  describeOllamaProviderDiscoveryContract,
  describeSglangProviderDiscoveryContract,
  describeVllmProviderDiscoveryContract,
} from "../../../test/helpers/plugins/provider-discovery-contract.js";

describeCloudflareAiGatewayProviderDiscoveryContract();
describeGithubCopilotProviderDiscoveryContract();
describeMinimaxProviderDiscoveryContract();
describeModelStudioProviderDiscoveryContract();
describeOllamaProviderDiscoveryContract();
describeSglangProviderDiscoveryContract();
describeVllmProviderDiscoveryContract();
