// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createMatrixClient } from "./client.js";

// Keep probe's runtime seam narrow so tests can mock it without loading the full client barrel.
export { createMatrixClient };
