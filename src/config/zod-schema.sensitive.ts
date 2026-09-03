// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { z } from "zod";

// Everything registered here will be redacted when the config is exposed,
// e.g. sent to the dashboard
export const sensitive = z.registry<undefined, z.ZodType>();
