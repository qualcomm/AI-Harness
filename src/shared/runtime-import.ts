// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export async function importRuntimeModule<T>(
  baseUrl: string,
  parts: readonly string[],
): Promise<T> {
  return (await import(new URL(parts.join(""), baseUrl).href)) as T;
}
