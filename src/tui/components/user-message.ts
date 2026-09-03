// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

export class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text: string) {
    super(text, 1, {
      bgColor: (line) => theme.userBg(line),
      color: (line) => theme.userText(line),
    });
  }
}
