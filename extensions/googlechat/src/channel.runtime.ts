// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import {
  probeGoogleChat as probeGoogleChatImpl,
  sendGoogleChatMessage as sendGoogleChatMessageImpl,
  uploadGoogleChatAttachment as uploadGoogleChatAttachmentImpl,
} from "./api.js";
import {
  resolveGoogleChatWebhookPath as resolveGoogleChatWebhookPathImpl,
  startGoogleChatMonitor as startGoogleChatMonitorImpl,
} from "./monitor.js";

export const googleChatChannelRuntime = {
  probeGoogleChat: probeGoogleChatImpl,
  sendGoogleChatMessage: sendGoogleChatMessageImpl,
  uploadGoogleChatAttachment: uploadGoogleChatAttachmentImpl,
  resolveGoogleChatWebhookPath: resolveGoogleChatWebhookPathImpl,
  startGoogleChatMonitor: startGoogleChatMonitorImpl,
};
