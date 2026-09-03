// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { runExtensionOxlint } from "./lib/run-extension-oxlint.mjs";

runExtensionOxlint({
  roots: ["extensions"],
  toolName: "oxlint-bundled-extensions",
  lockName: "oxlint-bundled-extensions",
  tempDirPrefix: "openclaw-bundled-extension-oxlint-",
  emptyMessage: "No bundled extension files found.",
});
