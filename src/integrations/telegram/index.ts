import type { Integration, IntegrationContext } from "../types";

/**
 * Telegram integration — port of telegram.sh
 * Forum topics per issue, bidirectional messaging.
 */

const TG_API = "https://api.telegram.org/bot";

let ctx: IntegrationContext | null = null;

function log(msg: string) {
  ctx?.log(msg);
}

async function getToken(): Promise<string | null> {
  if (!ctx) return null;
  return ctx.getConfig("botToken");
}

async function getChatId(): Promise<string | null> {
  if (!ctx) return null;
  return ctx.getConfig("chatId");
}

async function tgApi(method: string, body: Record<string, unknown>): Promise<any> {
  const token = await getToken();
  if (!token) {
    log(`tgApi(${method}): no bot token configured`);
    return null;
  }

  try {
    const resp = await fetch(`${TG_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    if (!json.ok) {
      log(`tgApi(${method}) error: ${json.description || JSON.stringify(json)}`);
    }
    return json;
  } catch (err) {
    log(`tgApi(${method}) fetch error: ${String(err)}`);
    return null;
  }
}

async function getTopicId(issueId: string): Promise<number | null> {
  if (!ctx) return null;
  const val = await ctx.getConfig(`topic:${issueId}`);
  return val ? parseInt(val) : null;
}

async function ensureTopic(issueId: string, title: string): Promise<number | null> {
  const existing = await getTopicId(issueId);
  if (existing) {
    log(`Topic for ${issueId}: ${existing} (cached)`);
    return existing;
  }

  const chatId = await getChatId();
  if (!chatId) {
    log(`ensureTopic(${issueId}): no chatId configured`);
    return null;
  }

  log(`Creating forum topic for ${issueId}...`);
  const resp = await tgApi("createForumTopic", {
    chat_id: chatId,
    name: title.substring(0, 128),
  });

  const topicId = resp?.result?.message_thread_id;
  if (topicId && ctx) {
    await ctx.setConfig(`topic:${issueId}`, topicId.toString());
    log(`Created topic for ${issueId}: ${topicId}`);
  } else {
    log(`Failed to create topic for ${issueId}: ${JSON.stringify(resp)}`);
  }

  return topicId ?? null;
}

async function send(issueId: string, message: string): Promise<void> {
  const chatId = await getChatId();
  if (!chatId) {
    log(`send(${issueId}): no chatId`);
    return;
  }

  let topicId = await getTopicId(issueId);
  if (!topicId) {
    topicId = await ensureTopic(issueId, issueId);
  }
  if (!topicId) {
    log(`send(${issueId}): no topic, message dropped`);
    return;
  }

  log(`Sending to ${issueId} (topic ${topicId}): ${message.substring(0, 60)}...`);
  await tgApi("sendMessage", {
    chat_id: chatId,
    message_thread_id: topicId,
    text: message,
    parse_mode: "HTML",
  });
}

async function sendAndPin(issueId: string, message: string): Promise<void> {
  const chatId = await getChatId();
  if (!chatId) return;

  let topicId = await getTopicId(issueId);
  if (!topicId) {
    log(`sendAndPin(${issueId}): no topic`);
    return;
  }

  const resp = await tgApi("sendMessage", {
    chat_id: chatId,
    message_thread_id: topicId,
    text: message,
    parse_mode: "HTML",
  });

  const msgId = resp?.result?.message_id;
  if (msgId) {
    await tgApi("pinChatMessage", {
      chat_id: chatId,
      message_id: msgId,
      disable_notification: true,
    });
  }
}

export const telegramIntegration: Integration = {
  name: "telegram",
  displayName: "Telegram Bot",
  configSchema: [
    {
      key: "botToken",
      label: "Bot Token",
      type: "secret",
      required: true,
      description: "Telegram Bot Token from @BotFather",
    },
    {
      key: "chatId",
      label: "Chat ID",
      type: "string",
      required: true,
      description: "Telegram Group Chat ID (with Forum Mode ON)",
    },
  ],

  async onRegister(context) {
    ctx = context;

    for (const key of ["botToken", "chatId"]) {
      const existing = await ctx.getConfig(key);
      if (existing === null) {
        await ctx.setConfig(key, "");
      }
    }

    ctx.log("Telegram integration registered");
  },

  async onAgentSpawned(event) {
    log(`onAgentSpawned: ${event.issueId}`);
    await ensureTopic(event.issueId, event.issueId);
    await sendAndPin(
      event.issueId,
      `📌 <b>${event.issueId}</b>`
    );
    await send(
      event.issueId,
      `🚀 Agent spawnowany\nBranch: ${event.branch}\nKontener: ${event.containerName}`
    );
  },

  async onAgentCommit(event) {
    log(`onAgentCommit: ${event.issueId} — ${event.message.substring(0, 50)}`);
    const emoji = event.message.includes("🟡") ? "🟡" : "🟢";
    await send(event.issueId, `${emoji} ${event.message}`);
  },

  async onAgentCompleted(event) {
    log(`onAgentCompleted: ${event.issueId}`);
    await send(event.issueId, "👁 Preview ready — awaiting review");
  },

  async onAgentPreview(event) {
    log(`onAgentPreview: ${event.issueId}`);
    let msg = "🔍 Preview ready\n";
    if (event.previewUrl) msg += `🌐 ${event.previewUrl}\n`;
    if (event.supabaseUrl) msg += `🗄️ ${event.supabaseUrl}\n`;
    await send(event.issueId, msg);
  },

  async onAgentMerged(event) {
    log(`onAgentMerged: ${event.issueId}`);
    await send(event.issueId, "✅ Merged to master");
  },

  async onAgentError(event) {
    log(`onAgentError: ${event.issueId} — ${event.error.substring(0, 80)}`);
    await send(event.issueId, `❌ Error: ${event.error.substring(0, 200)}`);
  },
};
