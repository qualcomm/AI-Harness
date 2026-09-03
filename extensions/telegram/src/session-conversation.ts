// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { parseTelegramTopicConversation } from "./topic-conversation.js";

export function resolveTelegramSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }
  return {
    id: parsed.chatId,
    threadId: parsed.topicId,
    baseConversationId: parsed.chatId,
    parentConversationCandidates: [parsed.chatId],
  };
}
