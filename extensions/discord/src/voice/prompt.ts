// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function formatVoiceIngressPrompt(transcript: string, speakerLabel?: string): string {
  const cleanedTranscript = transcript.trim();
  const cleanedLabel = speakerLabel?.trim();
  if (!cleanedLabel) {
    return cleanedTranscript;
  }
  return [`Voice transcript from speaker "${cleanedLabel}":`, cleanedTranscript].join("\n");
}
