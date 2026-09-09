#!/usr/bin/env bash
# Copyright (c) 2026 Qualcomm Innovation Center, Inc.
# SPDX-License-Identifier: MIT

run_logged() {
  local label="$1"
  shift
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-${label}.XXXXXX.log")"
  if ! "$@" >"$log_file" 2>&1; then
    cat "$log_file"
    rm -f "$log_file"
    return 1
  fi
  rm -f "$log_file"
}
