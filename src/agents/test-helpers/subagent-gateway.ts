// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function installAcceptedSubagentGatewayMock(mock: {
  mockImplementation: (
    impl: (opts: { method?: string; params?: unknown }) => Promise<unknown>,
  ) => unknown;
}) {
  mock.mockImplementation(async ({ method }) =>
    method === "agent" ? { runId: "run-1" } : method?.startsWith("sessions.") ? { ok: true } : {},
  );
}
