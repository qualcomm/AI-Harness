// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
declare module "qrcode-terminal" {
  type GenerateOptions = {
    small?: boolean;
  };

  type QrCodeTerminal = {
    generate: (input: string, options?: GenerateOptions, cb?: (output: string) => void) => void;
  };

  const qrcode: QrCodeTerminal;
  export default qrcode;
}
