// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type CliBannerTaglineMode = "random" | "default" | "off";

export type CliConfig = {
  banner?: {
    /**
     * Controls CLI banner tagline behavior.
     * - "random": pick from tagline pool (default)
     * - "default": always use DEFAULT_TAGLINE
     * - "off": hide tagline text
     */
    taglineMode?: CliBannerTaglineMode;
  };
};
