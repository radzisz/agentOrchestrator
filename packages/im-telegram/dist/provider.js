// ---------------------------------------------------------------------------
// TelegramIMProvider — implements BaseIMProvider with config-as-parameter
// ---------------------------------------------------------------------------
import { BaseIMProvider, } from "@orchestrator/contracts";
import { tgApi } from "./telegram-api.js";
export const telegramSchema = {
    type: "telegram",
    category: "im",
    displayName: "Telegram Bot",
    fields: [
        { key: "botToken", label: "Bot Token", type: "secret", required: true, description: "Telegram Bot Token from @BotFather" },
        { key: "chatId", label: "Chat ID", type: "string", required: true, description: "Telegram Group Chat ID (with Forum Mode ON)" },
    ],
};
export class TelegramIMProvider extends BaseIMProvider {
    constructor() {
        super(...arguments);
        this.name = "telegram";
        this.schema = telegramSchema;
    }
    async send(config, issueId, message) {
        var _a, _b, _c;
        const chatId = config.chatId;
        const token = config.botToken;
        if (!chatId || !token)
            return;
        let topicId = (_b = (_a = this.getTopicId) === null || _a === void 0 ? void 0 : _a.call(this, issueId)) !== null && _b !== void 0 ? _b : null;
        if (!topicId) {
            topicId = (_c = await this._ensureTopic(config, issueId)) !== null && _c !== void 0 ? _c : null;
        }
        if (!topicId)
            return;
        await tgApi(token, "sendMessage", {
            chat_id: chatId,
            message_thread_id: parseInt(topicId),
            text: message,
            parse_mode: "HTML",
        });
    }
    async ensureTopic(config, issueId, title) {
        return this._ensureTopic(config, issueId, title);
    }
    async closeTopic(config, issueId) {
        var _a;
        const chatId = config.chatId;
        const token = config.botToken;
        if (!chatId || !token)
            return;
        const topicId = (_a = this.getTopicId) === null || _a === void 0 ? void 0 : _a.call(this, issueId);
        if (!topicId)
            return;
        await tgApi(token, "closeForumTopic", {
            chat_id: chatId,
            message_thread_id: parseInt(topicId),
        });
    }
    async _ensureTopic(config, issueId, title) {
        var _a, _b, _c, _d, _e;
        const existing = (_a = this.getTopicId) === null || _a === void 0 ? void 0 : _a.call(this, issueId);
        if (existing)
            return existing;
        const chatId = config.chatId;
        const token = config.botToken;
        if (!chatId || !token)
            return null;
        const resolvedTitle = title || issueId;
        const resp = await tgApi(token, "createForumTopic", {
            chat_id: chatId,
            name: resolvedTitle.substring(0, 128),
        });
        const topicId = (_b = resp === null || resp === void 0 ? void 0 : resp.result) === null || _b === void 0 ? void 0 : _b.message_thread_id;
        if (topicId) {
            (_c = this.onTopicCreated) === null || _c === void 0 ? void 0 : _c.call(this, issueId, topicId.toString());
            // Pin intro message
            const pinResp = await tgApi(token, "sendMessage", {
                chat_id: chatId,
                message_thread_id: topicId,
                text: `\u{1F4CC} <b>${issueId}</b>: ${resolvedTitle}`,
                parse_mode: "HTML",
            });
            const msgId = (_d = pinResp === null || pinResp === void 0 ? void 0 : pinResp.result) === null || _d === void 0 ? void 0 : _d.message_id;
            if (msgId) {
                await tgApi(token, "pinChatMessage", {
                    chat_id: chatId,
                    message_id: msgId,
                    disable_notification: true,
                });
            }
        }
        return (_e = topicId === null || topicId === void 0 ? void 0 : topicId.toString()) !== null && _e !== void 0 ? _e : null;
    }
}
//# sourceMappingURL=provider.js.map