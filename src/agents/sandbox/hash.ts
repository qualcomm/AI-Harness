// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import crypto from "node:crypto";

export function hashTextSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
