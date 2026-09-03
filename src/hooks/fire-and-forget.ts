// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { logVerbose } from "../globals.js";

export function fireAndForgetHook(
  task: Promise<unknown>,
  label: string,
  logger: (message: string) => void = logVerbose,
): void {
  void task.catch((err) => {
    logger(`${label}: ${String(err)}`);
  });
}
