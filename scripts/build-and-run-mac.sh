#!/usr/bin/env bash
# Copyright (c) 2026 Qualcomm Innovation Center, Inc.
# SPDX-License-Identifier: MIT
set -euo pipefail
cd "$(dirname "$0")/../apps/macos"

BUILD_PATH=".build-local"
PRODUCT="OpenClaw"
BIN="$BUILD_PATH/debug/$PRODUCT"

printf "\n▶️  Building $PRODUCT (debug, build path: $BUILD_PATH)\n"
swift build -c debug --product "$PRODUCT" --build-path "$BUILD_PATH"

printf "\n⏹  Stopping existing $PRODUCT...\n"
killall -q "$PRODUCT" 2>/dev/null || true

printf "\n🚀 Launching $BIN ...\n"
nohup "$BIN" >/tmp/openclaw.log 2>&1 &
PID=$!
printf "Started $PRODUCT (PID $PID). Logs: /tmp/openclaw.log\n"
