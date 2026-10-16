// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { resolveGenieXInstallHint, resolveGenieXPlatformSupport } from "./platform.js";

describe("resolveGenieXPlatformSupport", () => {
  it("supports the three platforms GenieX ships for", () => {
    expect(resolveGenieXPlatformSupport({ platform: "win32", arch: "arm64" }).supported).toBe(true);
    expect(resolveGenieXPlatformSupport({ platform: "linux", arch: "arm64" }).supported).toBe(true);
    expect(resolveGenieXPlatformSupport({ platform: "android", arch: "arm64" }).supported).toBe(
      true,
    );
  });

  it("rejects x64 hosts so the plugin stays invisible there", () => {
    const result = resolveGenieXPlatformSupport({ platform: "win32", arch: "x64" });
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("ARM64");
  });

  it("rejects platforms GenieX does not build for", () => {
    const result = resolveGenieXPlatformSupport({ platform: "darwin", arch: "arm64" });
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("darwin");
  });

  it("reports a platform-arch label for diagnostics", () => {
    expect(resolveGenieXPlatformSupport({ platform: "win32", arch: "arm64" }).label).toBe(
      "win32-arm64",
    );
  });
});

describe("resolveGenieXInstallHint", () => {
  it("points Windows users at the installer and warns about PATH", () => {
    const hint = resolveGenieXInstallHint("win32");
    expect(hint.url).toContain("github.com/qualcomm/GenieX/releases");
    // The installer edits machine PATH, but this process already read its env,
    // so a restart is required — the UI must say so or users retry forever.
    expect(hint.note).toContain("restart");
  });

  it("gives Linux users the install script", () => {
    const hint = resolveGenieXInstallHint("linux");
    expect(hint.command).toContain("install.sh");
  });
});
