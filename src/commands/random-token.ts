// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import crypto from "node:crypto";

export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}
