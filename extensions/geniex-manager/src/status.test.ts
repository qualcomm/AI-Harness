// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { resolveGenieXStatus } from "./status.js";

const BASE_URL = "http://127.0.0.1:18181/v1";

describe("resolveGenieXStatus", () => {
  it("reports cli-missing with install guidance on a supported host", async () => {
    // Only meaningful when the test host itself is ARM64; on x64 the platform
    // branch wins first, which is asserted below.
    const status = await resolveGenieXStatus({
      baseUrl: BASE_URL,
      serve: { status: "inactive", reason: "not started" },
      env: { PATH: "" },
    });

    if (status.state === "unsupported-platform") {
      expect(status.reason).toBeTruthy();
      return;
    }
    expect(status.state).toBe("cli-missing");
    if (status.state === "cli-missing") {
      expect(status.install.url).toBeTruthy();
    }
  });

  it("always reports a platform label so the UI can explain itself", async () => {
    const status = await resolveGenieXStatus({
      baseUrl: BASE_URL,
      serve: { status: "inactive", reason: "not started" },
      env: { PATH: "" },
    });
    expect(status.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
