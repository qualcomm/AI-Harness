// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { Mock } from "vitest";
import { vi } from "vitest";

export const terminalNoteMock: Mock<(...args: unknown[]) => unknown> = vi.fn();

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => terminalNoteMock(...args),
}));

export async function loadDoctorCommandForTest(params?: { unmockModules?: string[] }) {
  vi.resetModules();
  vi.doMock("../terminal/note.js", () => ({
    note: (...args: unknown[]) => terminalNoteMock(...args),
  }));
  for (const modulePath of params?.unmockModules ?? []) {
    vi.doUnmock(modulePath);
  }
  const { doctorCommand } = await import("./doctor.js");
  terminalNoteMock.mockClear();
  return doctorCommand;
}
