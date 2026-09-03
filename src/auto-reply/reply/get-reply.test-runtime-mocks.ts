// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { vi } from "vitest";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

registerGetReplyCommonMocks();

vi.mock("../../link-understanding/apply.runtime.js", () => ({
  applyLinkUnderstanding: vi.fn(async () => undefined),
}));

vi.mock("../../media-understanding/apply.runtime.js", () => ({
  applyMediaUnderstanding: vi.fn(async () => undefined),
}));
