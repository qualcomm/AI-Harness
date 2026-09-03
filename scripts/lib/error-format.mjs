// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}
