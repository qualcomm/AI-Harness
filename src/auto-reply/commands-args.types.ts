// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type CommandArgValue = string | number | boolean | bigint;
export type CommandArgValues = Record<string, CommandArgValue>;

export type CommandArgs = {
  raw?: string;
  values?: CommandArgValues;
};
