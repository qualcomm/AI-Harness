// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
declare module "silk-wasm" {
  export type SilkCodecResult = {
    data: Uint8Array;
    duration: number;
  };

  export function isSilk(input: Uint8Array): boolean;

  export function decode(input: Uint8Array, sampleRate: number): Promise<SilkCodecResult>;

  export function encode(input: Uint8Array, sampleRate: number): Promise<SilkCodecResult>;
}
