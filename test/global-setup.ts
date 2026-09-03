// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { installTestEnv } from "./test-env";

export default async () => {
  const { cleanup } = installTestEnv();
  return () => cleanup();
};
