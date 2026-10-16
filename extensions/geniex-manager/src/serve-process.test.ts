// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { buildGenieXServeArgs } from "./serve-process.js";

describe("buildGenieXServeArgs", () => {
  it("always binds an explicit host so the port is predictable", () => {
    expect(buildGenieXServeArgs({})).toEqual(["serve", "--host", "127.0.0.1:18181"]);
  });

  it("honours a configured host", () => {
    expect(buildGenieXServeArgs({ host: "127.0.0.1:19000" })).toEqual([
      "serve",
      "--host",
      "127.0.0.1:19000",
    ]);
  });

  it("passes the default compute unit through", () => {
    expect(buildGenieXServeArgs({ compute: "cpu" })).toEqual([
      "serve",
      "--host",
      "127.0.0.1:18181",
      "--compute",
      "cpu",
    ]);
  });

  it("omits compute when it is blank, leaving GenieX's own default", () => {
    expect(buildGenieXServeArgs({ compute: "   " })).toEqual(["serve", "--host", "127.0.0.1:18181"]);
  });

  it("passes keepalive 0, which means unload as soon as idle", () => {
    expect(buildGenieXServeArgs({ keepAliveSeconds: 0 })).toEqual([
      "serve",
      "--host",
      "127.0.0.1:18181",
      "--keepalive",
      "0",
    ]);
  });

  it("clamps a negative keepalive rather than passing it on", () => {
    expect(buildGenieXServeArgs({ keepAliveSeconds: -5 })).toEqual([
      "serve",
      "--host",
      "127.0.0.1:18181",
      "--keepalive",
      "0",
    ]);
  });

  it("emits discrete argv entries, never a shell string", () => {
    // Guards the spawn contract: arguments must reach the process unparsed so a
    // hostile model name or host cannot be interpreted by a shell.
    const args = buildGenieXServeArgs({ host: "127.0.0.1:18181", compute: "npu" });
    expect(args.every((arg) => !arg.includes(" "))).toBe(true);
  });
});
