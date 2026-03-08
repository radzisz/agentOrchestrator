// ---------------------------------------------------------------------------
// TelegramIMProvider — implements BaseIMProvider with config-as-parameter
// ---------------------------------------------------------------------------

import {
  BaseIMProvider,
  type ProviderTypeSchema,
} from "@orchestrator/contracts";
import { tgApi } from "./telegram-api.js";

export const telegramSchema: ProviderTypeSchema = {
  type: "telegram",
  category: "im",
  displayName: "Telegram Bot",
  fields: [
    { key: "botToken", label: "Bot Token", type: "secret", required: true, description: "Telegram Bot Token from @BotFather" },
    { key: "chatId", label: "Chat ID", type: "string", required: true, description: "Telegram Group Chat ID (with Forum Mode ON)" },
  ],
};

export class TelegramIMProvider extends BaseIMProvider {
  readonly name = "telegram";
  readonly schema = telegramSchema;

  /**
   * Optional callback to persist topic IDs.
   * The host provides this so the provider doesn't need to access storage.
   */
  onTopicCreated?: (issueId: string, topicId: string) => void;

  /**
   * Optional callback to resolve topic IDs.
   * The host provides this so the provider doesn't need to access storage.
   */
  getTopicId?: (issueId: string) => string | null;

  async send(config: Record<string, string>, issueId: string, message: string): Promise<void> {
    const chatId = config.chatId;
    const token = config.botToken;
    if (!chatId || !token) return;

    let topicId = this.getTopicId?.(issueId) ?? null;
    if (!topicId) {
      topicId = await this._ensureTopic(config, issueId) ?? null;
    }
    if (!topicId) return;

    await tgApi(token, "sendMessage", {
      chat_id: chatId,
      message_thread_id: parseInt(topicId),
      text: message,
      parse_mode: "HTML",
    });
  }

  override async ensureTopic(config: Record<string, string>, issueId: string, title: string): Promise<string | null> {
    return this._ensureTopic(config, issueId, title);
  }

  override async closeTopic(config: Record<string, string>, issueId: string): Promise<void> {
    const chatId = config.chatId;
    const token = config.botToken;
    if (!chatId || !token) return;

    const topicId = this.getTopicId?.(issueId);
    if (!topicId) return;

    await tgApi(token, "closeForumTopic", {
      chat_id: chatId,
      message_thread_id: parseInt(topicId),
    });
  }

  private async _ensureTopic(config: Record<string, string>, issueId: string, title?: string): Promise<string | null> {
    const existing = this.getTopicId?.(issueId);
    if (existing) return existing;

    const chatId = config.chatId;
    const token = config.botToken;
    if (!chatId || !token) return null;

    const resolvedTitle = title || issueId;
    const resp = await tgApi(token, "createForumTopic", {
      chat_id: chatId,
      name: resolvedTitle.substring(0, 128),
    });

    const topicId = resp?.result?.message_thread_id;
    if (topicId) {
      this.onTopicCreated?.(issueId, topicId.toString());

      // Pin intro message
      const pinResp = await tgApi(token, "sendMessage", {
        chat_id: chatId,
        message_thread_id: topicId,
        text: `\u{1F4CC} <b>${issueId}</b>: ${resolvedTitle}`,
        parse_mode: "HTML",
      });
      const msgId = pinResp?.result?.message_id;
      if (msgId) {
        await tgApi(token, "pinChatMessage", {
          chat_id: chatId,
          message_id: msgId,
          disable_notification: true,
        });
      }
    }

    return topicId?.toString() ?? null;
  }
}
