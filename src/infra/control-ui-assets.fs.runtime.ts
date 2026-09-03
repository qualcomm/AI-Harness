// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import fs from "node:fs";

export const existsSync = fs.existsSync.bind(fs);
export const readFileSync = fs.readFileSync.bind(fs);
export const statSync = fs.statSync.bind(fs);
export const realpathSync = fs.realpathSync.bind(fs);
