// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import type { RemoteShellSandboxHandle, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";

export type OpenShellFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

export type OpenShellSandboxBackend = SandboxBackendHandle &
  RemoteShellSandboxHandle & {
    mode: "mirror" | "remote";
    syncLocalPathToRemote(localPath: string, remotePath: string): Promise<void>;
  };
