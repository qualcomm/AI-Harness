// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { parseGenieXVersion, resolveGenieXCliPath } from "./cli.js";

describe("parseGenieXVersion", () => {
  it("reads a plain semver", () => {
    expect(parseGenieXVersion("geniex version 0.3.1")).toBe("0.3.1");
  });

  it("keeps prerelease and build suffixes", () => {
    expect(parseGenieXVersion("GenieX-CLI 1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });

  it("finds the version anywhere in multiline output", () => {
    expect(parseGenieXVersion("GenieX\n  Version: 0.4.0\n  Commit: abc123")).toBe("0.4.0");
  });

  it("returns undefined when no version is present", () => {
    // The wording of `geniex version` is not a stable contract, so an
    // unparseable result degrades instead of failing the whole probe.
    expect(parseGenieXVersion("command not found")).toBeUndefined();
    expect(parseGenieXVersion("")).toBeUndefined();
  });
});

describe("resolveGenieXCliPath", () => {
  it("returns undefined when PATH is empty", () => {
    // A missing CLI is the normal state before the user installs GenieX, so
    // this reports absence rather than throwing.
    expect(resolveGenieXCliPath({ PATH: "" })).toBeUndefined();
  });

  it("returns undefined when PATH holds no geniex executable", () => {
    expect(
      resolveGenieXCliPath({ PATH: "/nonexistent/geniex/bin", PATHEXT: ".EXE;.CMD" }),
    ).toBeUndefined();
  });
});
