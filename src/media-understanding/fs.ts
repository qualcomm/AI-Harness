// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fs from "node:fs/promises";

export async function fileExists(filePath?: string | null): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
