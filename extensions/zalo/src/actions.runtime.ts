// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { sendMessageZalo as sendMessageZaloImpl } from "./send.js";

export const zaloActionsRuntime = {
  sendMessageZalo: sendMessageZaloImpl,
};
