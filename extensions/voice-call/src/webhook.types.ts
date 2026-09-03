// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type WebhookResponsePayload = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};
