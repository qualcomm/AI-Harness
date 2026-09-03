// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { groqMediaUnderstandingProvider } from "./media-understanding-provider.js";

export default definePluginEntry({
  id: "groq",
  name: "Groq Media Understanding",
  description: "Bundled Groq audio transcription provider",
  register(api) {
    api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
  },
});
