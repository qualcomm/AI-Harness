// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { afterAll } from "vitest";
import { installSharedTestSetup } from "./setup.shared.js";

const testEnv = installSharedTestSetup({ loadProfileEnv: false });

afterAll(() => {
  testEnv.cleanup();
});
