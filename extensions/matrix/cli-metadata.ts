// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMatrixCliMetadata } from "./src/cli-metadata.js";

export { registerMatrixCliMetadata } from "./src/cli-metadata.js";

export default definePluginEntry({
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  register: registerMatrixCliMetadata,
});
