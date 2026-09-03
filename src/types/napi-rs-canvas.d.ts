// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
declare module "@napi-rs/canvas" {
  export type Canvas = {
    toBuffer(type?: string): Buffer;
  };

  export function createCanvas(width: number, height: number): Canvas;
}
