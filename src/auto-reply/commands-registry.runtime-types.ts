// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

export type ShouldHandleTextCommands = (params: ShouldHandleTextCommandsParams) => boolean;
