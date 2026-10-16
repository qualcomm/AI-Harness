// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
/**
 * Platform gating for GenieX.
 *
 * GenieX runs only on Qualcomm Snapdragon: Windows ARM64 (Snapdragon X / X2),
 * Linux ARM64 (Dragonwing), and Android. On every other host the plugin should
 * stay completely invisible — no failing provider, no restart loop, no log
 * noise — so this check runs before anything that touches the filesystem or
 * network.
 *
 * Note this reports *architecture* support, not the presence of a Snapdragon
 * chip: an ARM64 Windows VM on Apple silicon looks identical from here. Actual
 * chipset detection lives in GenieX itself (`detect_host_chipset`), and the CLI
 * probe below is what really decides whether GenieX is usable.
 */

export type GenieXPlatformSupport = {
  supported: boolean;
  /** Stable `<platform>-<arch>` label for diagnostics and the setup UI. */
  label: string;
  /** Why the platform was rejected; undefined when supported. */
  reason?: string;
};

export function resolveGenieXPlatformSupport(params?: {
  platform?: NodeJS.Platform;
  arch?: string;
}): GenieXPlatformSupport {
  const platform = params?.platform ?? process.platform;
  const arch = params?.arch ?? process.arch;
  const label = `${platform}-${arch}`;

  if (platform === "android") {
    return { supported: true, label };
  }
  if (platform === "win32" || platform === "linux") {
    if (arch === "arm64") {
      return { supported: true, label };
    }
    return {
      supported: false,
      label,
      reason: `GenieX requires an ARM64 host; this is ${arch}.`,
    };
  }
  return {
    supported: false,
    label,
    reason: `GenieX supports Windows ARM64, Linux ARM64, and Android; this is ${platform}.`,
  };
}

/** Where to get GenieX, by platform. Surfaced in the setup guidance. */
export function resolveGenieXInstallHint(platform: NodeJS.Platform = process.platform): {
  url: string;
  command?: string;
  note?: string;
} {
  if (platform === "win32") {
    return {
      url: "https://github.com/qualcomm/GenieX/releases",
      // The installer edits the machine PATH, but this process already captured
      // its environment at startup, so a restart is required — not just a
      // re-probe. Saying so up front avoids a confusing "still not found" loop.
      note: "After installing, restart the gateway so it picks up the updated PATH.",
    };
  }
  if (platform === "linux") {
    return {
      url: "https://geniex.aihub.qualcomm.com/en/run/cli/install",
      command:
        "curl -fsSL https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/install.sh | sh",
      note: "After installing, restart the gateway so it picks up the updated PATH.",
    };
  }
  return { url: "https://geniex.aihub.qualcomm.com/en/run/cli/install" };
}
