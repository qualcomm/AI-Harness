// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function createCapturedIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: unknown) {
          stdout += String(chunk);
        },
      },
      stderr: {
        write(chunk: unknown) {
          stderr += String(chunk);
        },
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}
