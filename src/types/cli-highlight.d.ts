// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
declare module "cli-highlight" {
  export type HighlightOptions = {
    language?: string;
    theme?: unknown;
    ignoreIllegals?: boolean;
  };

  export function highlight(code: string, options?: HighlightOptions): string;
  export function supportsLanguage(language: string): boolean;
}
