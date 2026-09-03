// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { CommandHandlerResult } from "../commands-types.js";
import { buildSubagentsHelp, stopWithText } from "./shared.js";

export function handleSubagentsHelpAction(): CommandHandlerResult {
  return stopWithText(buildSubagentsHelp());
}
