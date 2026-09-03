// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const loadImageRuntime = createLazyRuntimeModule(() => import("./image.js"));
const bindImageRuntime = createLazyRuntimeMethodBinder(loadImageRuntime);

export const describeImageWithModel = bindImageRuntime((runtime) => runtime.describeImageWithModel);
export const describeImagesWithModel = bindImageRuntime(
  (runtime) => runtime.describeImagesWithModel,
);
