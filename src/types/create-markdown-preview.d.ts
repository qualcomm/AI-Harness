// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
declare module "@create-markdown/preview" {
  export type PreviewThemeOptions = {
    sanitize?: ((html: string) => string) | undefined;
  };

  export function applyPreviewTheme(html: string, options?: PreviewThemeOptions): string;
}
