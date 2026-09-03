// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export const WHISPER_BASE_AUDIO_MODEL = {
  enabled: true,
  models: [
    {
      command: "whisper",
      type: "cli",
      args: ["--model", "base"],
      timeoutSeconds: 2,
    },
  ],
};
