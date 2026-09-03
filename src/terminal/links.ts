// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { formatTerminalLink } from "./terminal-link.js";

function resolveDocsRoot(): string {
  return "https://docs.openclaw.ai";
}

export function formatDocsLink(
  path: string,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const trimmed = path.trim();
  const docsRoot = resolveDocsRoot();
  const url = trimmed.startsWith("http")
    ? trimmed
    : `${docsRoot}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}
