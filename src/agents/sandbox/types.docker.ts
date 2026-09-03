// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { SandboxDockerSettings } from "../../config/types.sandbox.js";

type RequiredDockerConfigKeys =
  | "image"
  | "containerPrefix"
  | "workdir"
  | "readOnlyRoot"
  | "tmpfs"
  | "network"
  | "capDrop";

export type SandboxDockerConfig = Omit<SandboxDockerSettings, RequiredDockerConfigKeys> &
  Required<Pick<SandboxDockerSettings, RequiredDockerConfigKeys>>;
