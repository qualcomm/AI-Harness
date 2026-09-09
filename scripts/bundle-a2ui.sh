#!/usr/bin/env bash
# Copyright (c) 2026 Qualcomm Innovation Center, Inc.
# SPDX-License-Identifier: MIT
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT_DIR/scripts/bundle-a2ui.mjs" "$@"
