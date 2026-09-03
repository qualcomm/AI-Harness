// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
process.stdout.write("ready\n");

const keepAlive = setInterval(() => {}, 1000);

const shutdown = () => {
  clearInterval(keepAlive);
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
