// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: Object.assign(vi.fn(), { __promisify__: vi.fn() }),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../../test/helpers/node-builtin-mocks.js");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: execFileMock,
    },
  );
});

import { runFeishuCalendarAgenda } from "../src/feishu-calendar-exec.js";

function succeed(stdout: unknown) {
  execFileMock.mockImplementationOnce(
    (_cliPath: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(null, JSON.stringify(stdout), "");
    },
  );
}

/** lark-cli writes its failure envelope to stderr, pretty-printed across multiple lines. */
function failWithStderrEnvelope(envelope: unknown) {
  execFileMock.mockImplementationOnce(
    (_cliPath: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(new Error("exit 1"), "", JSON.stringify(envelope, null, 2));
    },
  );
}

function failWithStdoutEnvelope(envelope: unknown) {
  execFileMock.mockImplementationOnce(
    (_cliPath: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(new Error("exit 1"), JSON.stringify(envelope), "");
    },
  );
}

function failWithStderr(stderr: string) {
  execFileMock.mockImplementationOnce(
    (_cliPath: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(new Error("exit 1"), "", stderr);
    },
  );
}

describe("runFeishuCalendarAgenda", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed data on success", async () => {
    succeed({ ok: true, identity: "user", data: [{ summary: "trip" }], meta: { count: 1 } });

    const result = await runFeishuCalendarAgenda({ cliPath: undefined });

    expect(result).toEqual([{ summary: "trip" }]);
  });

  it("defaults to the `lark-cli` binary name and passes date range flags", async () => {
    succeed({ ok: true, identity: "user", data: [] });

    await runFeishuCalendarAgenda({ cliPath: undefined, start: "2026-09-10", end: "2026-10-10" });

    expect(execFileMock).toHaveBeenCalledWith(
      "lark-cli",
      [
        "calendar",
        "+agenda",
        "--start",
        "2026-09-10",
        "--end",
        "2026-10-10",
        "--as",
        "user",
        "--format",
        "json",
      ],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("routes through a shell on Windows so the lark-cli.cmd shim can run, with args still passed as an array", async () => {
    succeed({ ok: true, identity: "user", data: [] });

    await runFeishuCalendarAgenda({ cliPath: undefined });

    const expectedShell = process.platform === "win32";
    expect(execFileMock).toHaveBeenCalledWith(
      "lark-cli",
      expect.any(Array),
      expect.objectContaining({ shell: expectedShell }),
      expect.any(Function),
    );
  });

  it("honors a configured cliPath override", async () => {
    succeed({ ok: true, identity: "user", data: [] });

    await runFeishuCalendarAgenda({ cliPath: "C:\\tools\\lark-cli.exe" });

    expect(execFileMock).toHaveBeenCalledWith(
      "C:\\tools\\lark-cli.exe",
      expect.any(Array),
      expect.anything(),
      expect.any(Function),
    );
  });

  /**
   * Regression: lark-cli reports failures as a pretty-printed JSON envelope on stderr. Reading
   * only stdout surfaced the raw multi-line JSON, which downstream summaries truncated at the
   * first newline — a real "not bound to this workspace" error showed up as just `{`.
   */
  it("extracts message and hint from an error envelope on stderr", async () => {
    failWithStderrEnvelope({
      ok: false,
      identity: "bot",
      error: {
        type: "config",
        subtype: "not_configured",
        message: "openclaw context detected but lark-cli is not bound to it",
        hint: "read `lark-cli config bind --help`",
      },
    });

    await expect(runFeishuCalendarAgenda({ cliPath: undefined })).rejects.toThrow(
      "openclaw context detected but lark-cli is not bound to it (read `lark-cli config bind --help`)",
    );
  });

  it("still reads an error envelope that arrives on stdout instead", async () => {
    failWithStdoutEnvelope({
      ok: false,
      identity: "user",
      error: { type: "api", message: "insufficient scope", hint: "run auth login --domain calendar" },
    });

    await expect(runFeishuCalendarAgenda({ cliPath: undefined })).rejects.toThrow(
      "insufficient scope",
    );
  });

  it("falls back to stderr when the failure has no parseable JSON envelope", async () => {
    failWithStderr("lark-cli: command not found");

    await expect(runFeishuCalendarAgenda({ cliPath: undefined })).rejects.toThrow(
      "command not found",
    );
  });

  it("throws when a successful exit returns non-JSON output", async () => {
    execFileMock.mockImplementationOnce(
      (_cliPath: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        cb(null, "not json", "");
      },
    );

    await expect(runFeishuCalendarAgenda({ cliPath: undefined })).rejects.toThrow(
      "did not return valid JSON",
    );
  });
});
