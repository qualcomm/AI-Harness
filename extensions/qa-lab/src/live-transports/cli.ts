// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { matrixQaCliRegistration } from "./matrix/cli.js";
import type { LiveTransportQaCliRegistration } from "./shared/live-transport-cli.js";
import { telegramQaCliRegistration } from "./telegram/cli.js";

export const LIVE_TRANSPORT_QA_CLI_REGISTRATIONS: readonly LiveTransportQaCliRegistration[] = [
  telegramQaCliRegistration,
  matrixQaCliRegistration,
];
