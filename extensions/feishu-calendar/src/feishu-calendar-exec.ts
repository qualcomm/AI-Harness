// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";

export const FEISHU_CALENDAR_TIMEOUT_MS = 30 * 1000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const DEFAULT_CLI_PATH = "lark-cli";

function execFileAsync(
  cliPath: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath,
      args,
      {
        ...options,
        // `npm install -g @larksuite/cli` puts a `lark-cli.cmd` shim on PATH, not a real
        // `.exe`. Windows' CreateProcess (what execFile calls without `shell`) can neither
        // resolve the bare name to that shim via PATHEXT nor execute a .cmd/.bat file
        // directly — both fail (ENOENT, then EINVAL) even though typing the same command in
        // a terminal works fine, because the terminal itself does that resolution. Routing
        // through cmd.exe on Windows reproduces exactly what the terminal does. execFile
        // still passes `args` as a real array here (not a hand-built string), so cmd.exe
        // quotes each argument itself — this is not the raw-string-concatenation risk that
        // `shell: true` carries with `exec()`.
        shell: process.platform === "win32",
      },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

type LarkCliEnvelope =
  | { ok: true; identity: string; data: unknown; meta?: Record<string, unknown> }
  | {
      ok: false;
      identity: string;
      error: { type: string; subtype?: string; code?: number; message: string; hint?: string };
    };

function parseLarkCliOutput(stdout: string): LarkCliEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`lark-cli did not return valid JSON: ${stdout.slice(0, 500)}`);
  }
  return parsed as LarkCliEnvelope;
}

function tryParseLarkCliOutput(stdout: string): LarkCliEnvelope | null {
  try {
    return parseLarkCliOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * Reads the user's Feishu/Lark calendar agenda for a date range via the official `lark-cli`
 * (already authenticated out-of-band via `lark-cli auth login`; this tool never handles
 * credentials itself).
 */
export async function runFeishuCalendarAgenda(params: {
  cliPath: string | undefined;
  start?: string;
  end?: string;
  calendarId?: string;
}): Promise<unknown> {
  const cliPath = params.cliPath?.trim() || DEFAULT_CLI_PATH;
  const args = [
    "calendar",
    "+agenda",
    ...(params.start ? ["--start", params.start] : []),
    ...(params.end ? ["--end", params.end] : []),
    ...(params.calendarId ? ["--calendar-id", params.calendarId] : []),
    // Without an explicit identity, lark-cli fails to resolve the already-bound user token
    // (token_missing / need_user_authorization) even when `auth status` shows it as valid.
    "--as",
    "user",
    "--format",
    "json",
  ];

  let stdout: string;
  try {
    const result = await execFileAsync(cliPath, args, {
      timeout: FEISHU_CALENDAR_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    stdout = result.stdout;
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message: string };
    // lark-cli writes its `{ok:false, error:{message,hint}}` envelope to STDERR on failure
    // (stdout only carries the success envelope), so stderr is checked first. Extracting
    // `message`/`hint` matters because the raw envelope is pretty-printed across several
    // lines, and downstream summaries truncate at the first newline — which reduced a real
    // "not bound to this workspace" error to just `{` in the progress card.
    const envelope =
      tryParseLarkCliOutput(execErr.stderr ?? "") ?? tryParseLarkCliOutput(execErr.stdout ?? "");
    if (envelope && !envelope.ok) {
      throw new Error(
        `lark-cli calendar +agenda failed: ${envelope.error.message}${envelope.error.hint ? ` (${envelope.error.hint})` : ""}`,
      );
    }
    throw new Error(
      `lark-cli calendar +agenda failed: ${execErr.stderr?.trim() || execErr.message}`,
    );
  }

  const envelope = parseLarkCliOutput(stdout);
  if (!envelope.ok) {
    throw new Error(
      `lark-cli calendar +agenda failed: ${envelope.error.message}${envelope.error.hint ? ` (${envelope.error.hint})` : ""}`,
    );
  }
  return envelope.data;
}
