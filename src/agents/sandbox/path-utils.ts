// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import path from "node:path";

export function normalizeContainerPath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized === "." ? "/" : normalized;
}

export function isPathInsideContainerRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeContainerPath(root);
  const normalizedTarget = normalizeContainerPath(target);
  if (normalizedRoot === "/") {
    return true;
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
