// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
declare module "@aws/bedrock-token-generator" {
  export function getTokenProvider(opts?: {
    region?: string;
    expiresInSeconds?: number;
  }): () => Promise<string>;
}
