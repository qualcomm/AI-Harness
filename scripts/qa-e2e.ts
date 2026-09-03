// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { runQaE2eSelfCheck } from "../extensions/qa-lab/api.js";

const outputPath = process.argv[2]?.trim() || ".artifacts/qa-e2e/self-check.md";

const result = await runQaE2eSelfCheck({ outputPath });
process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
