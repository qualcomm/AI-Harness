// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { vi } from "vitest";
import { createDefaultResolvedZalouserAccount } from "./test-helpers.js";

vi.mock("./accounts.js", () => {
  return {
    listZalouserAccountIds: () => ["default"],
    resolveDefaultZalouserAccountId: () => "default",
    resolveZalouserAccountSync: () => createDefaultResolvedZalouserAccount(),
    resolveZalouserAccount: async () => createDefaultResolvedZalouserAccount(),
    listEnabledZalouserAccounts: async () => [createDefaultResolvedZalouserAccount()],
    getZcaUserInfo: async () => null,
    checkZcaAuthenticated: async () => false,
  };
});
