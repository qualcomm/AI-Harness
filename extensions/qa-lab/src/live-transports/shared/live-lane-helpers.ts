// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function appendLiveLaneIssue(issues: string[], label: string, error: unknown) {
  issues.push(`${label}: ${formatErrorMessage(error)}`);
}

export function buildLiveLaneArtifactsError(params: {
  heading: string;
  artifacts: Record<string, string>;
  details?: string[];
}) {
  return [
    params.heading,
    ...(params.details ?? []),
    "Artifacts:",
    ...Object.entries(params.artifacts).map(([label, filePath]) => `- ${label}: ${filePath}`),
  ].join("\n");
}
