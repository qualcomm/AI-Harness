// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
};

export type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  rawText?: string | null;
};

export type SidebarContent = MarkdownSidebarContent | CanvasSidebarContent;
