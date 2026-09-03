// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const connectHandlers: GatewayRequestHandlers = {
  connect: ({ respond }) => {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "connect is only valid as the first request"),
    );
  },
};
