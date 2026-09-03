// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
// Test setup file for nostr extension
import { vi } from "vitest";

// Mock console.error to suppress noise in tests
vi.spyOn(console, "error").mockImplementation(() => {});
