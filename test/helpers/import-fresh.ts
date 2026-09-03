// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export async function importFreshModule<TModule>(
  from: string,
  specifier: string,
): Promise<TModule> {
  // Vitest keys module instances by the full URL string, including the query
  // suffix. These tests rely on that behavior to emulate code-split chunks.
  return (await import(/* @vite-ignore */ new URL(specifier, from).href)) as TModule;
}
