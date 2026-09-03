// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type SecretRefResolveCache = {
  resolvedByRefKey?: Map<string, Promise<unknown>>;
  filePayloadByProvider?: Map<string, Promise<unknown>>;
};
