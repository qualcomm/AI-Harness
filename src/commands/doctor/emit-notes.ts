// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
export function emitDoctorNotes(params: {
  note: (message: string, title?: string) => void;
  changeNotes?: string[];
  warningNotes?: string[];
}): void {
  for (const change of params.changeNotes ?? []) {
    params.note(change, "Doctor changes");
  }
  for (const warning of params.warningNotes ?? []) {
    params.note(warning, "Doctor warnings");
  }
}
