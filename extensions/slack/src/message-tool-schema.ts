// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { Type } from "@sinclair/typebox";

export function createSlackMessageToolBlocksSchema() {
  return Type.Array(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description: "Slack Block Kit payload blocks (Slack only).",
      },
    ),
  );
}
