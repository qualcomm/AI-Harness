// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const MODEL_AVAILABILITY_UNAVAILABLE_CODE = "MODEL_AVAILABILITY_UNAVAILABLE";

export function formatErrorWithStack(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}

export function shouldFallbackToAuthHeuristics(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === MODEL_AVAILABILITY_UNAVAILABLE_CODE;
}
