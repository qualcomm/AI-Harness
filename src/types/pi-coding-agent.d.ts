// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import "@mariozechner/pi-coding-agent";

declare module "@mariozechner/pi-coding-agent" {
  interface Skill {
    // OpenClaw relies on the source identifier returned by pi skill loaders.
    source: string;
  }
}
