// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
type AdapterLike = {
  id: string;
};

export function filterUnregisteredMemoryEmbeddingProviderAdapters<T extends AdapterLike>(params: {
  builtinAdapters: readonly T[];
  registeredAdapters: readonly AdapterLike[];
}): T[] {
  const existingIds = new Set(params.registeredAdapters.map((adapter) => adapter.id));
  return params.builtinAdapters.filter((adapter) => !existingIds.has(adapter.id));
}
