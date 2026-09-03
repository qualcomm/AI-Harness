// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

vi.mock("../tools/canvas-tool.js", () => ({
  createCanvasTool: () => stubTool("canvas"),
}));
