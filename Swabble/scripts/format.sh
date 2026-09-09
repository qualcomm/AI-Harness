#!/bin/bash
# Copyright (c) 2026 Qualcomm Innovation Center, Inc.
# SPDX-License-Identifier: MIT
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${ROOT}/.swiftformat"
swiftformat --config "$CONFIG" "$ROOT/Sources"
