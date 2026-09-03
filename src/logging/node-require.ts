// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function resolveNodeRequireFromMeta(metaUrl: string): NodeJS.Require | null {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return null;
  }
  try {
    const moduleNamespace = getBuiltinModule("module") as {
      createRequire?: (id: string) => NodeJS.Require;
    };
    const createRequire =
      typeof moduleNamespace.createRequire === "function" ? moduleNamespace.createRequire : null;
    return createRequire ? createRequire(metaUrl) : null;
  } catch {
    return null;
  }
}
