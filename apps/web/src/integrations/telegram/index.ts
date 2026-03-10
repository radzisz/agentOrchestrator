import type { Integration, IntegrationContext } from "../types";
import { resolveCredentials } from "@/lib/im-config";

/**
 * Telegram integration — port of telegram.sh
 * Forum topics per issue, bidirectional messaging.
 */

const TG_API = "https://api.telegram.org/bot";

let ctx: IntegrationContext | null = null;
const _errorDebounce = new Map<string, { lastSent: number; count: number }>();

function log(msg: string) {
  ctx?.log(msg);
}

async function tgApi(token: string, method: string, body: Record<string, unknown>): Promise<any> {
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

function getTopicId(issueId: string): number | null {
  try {
    const store = require("@/lib/store") as typeof import("@/lib/store");
    for (const p of store.listProjects()) {
      const val = store.getAgentMeta(p.path, issueId, "telegram:topicId");
      if (val) return parseInt(val);
    }
  } catch { /* ignore */ }
  return null;
}

function setTopicId(issueId: string, topicId: number): void {
  try {
    const store = require("@/lib/store") as typeof import("@/lib/store");
    for (const p of store.listProjects()) {
      if (store.getAgent(p.path, issueId)) {
        store.setAgentMeta(p.path, issueId, "telegram:topicId", topicId.toString());
        return;
      }
    }
  } catch { /* ignore */ }
}

async function resolveTitle(issueId: string): Promise<string> {
  try {
    const store = await import("@/lib/store");
    const projects = store.listProjects();
    for (const p of projects) {
      const agent = store.getAgent(p.path, issueId);
      if (agent?.title && agent.title !== issueId) return agent.title;
    }
  } catch { /* ignore */ }
  return issueId;
}

async function ensureTopic(
  creds: { token: string; chatId: string },
  issueId: string,
  title?: string,
): Promise<number | null> {
  const existing = getTopicId(issueId);
  if (existing) {
    log(`Topic for ${issueId}: ${existing} (cached)`);
    return existing;
  }

  const resolvedTitle = title || `${issueId}: ${await resolveTitle(issueId)}`;

  log(`Creating forum topic for ${issueId}...`);
  const resp = await tgApi(creds.token, "createForumTopic", {
    chat_id: creds.chatId,
    name: resolvedTitle.substring(0, 128),
  });

  const topicId = resp?.result?.message_thread_id;
  if (topicId) {
    setTopicId(issueId, topicId);
    log(`Created topic for ${issueId}: ${topicId}`);

    const pinResp = await tgApi(creds.token, "sendMessage", {
      chat_id: creds.chatId,
      message_thread_id: topicId,
      text: `📌 <b>${issueId}</b>: ${title || await resolveTitle(issueId)}`,
      parse_mode: "HTML",
    });
    const msgId = pinResp?.result?.message_id;
    if (msgId) {
      await tgApi(creds.token, "pinChatMessage", {
        chat_id: creds.chatId,
        message_id: msgId,
        disable_notification: true,
      });
    }
  } else {
    log(`Failed to create topic for ${issueId}: ${JSON.stringify(resp)}`);
  }

  return topicId ?? null;
}

async function send(issueId: string, message: string): Promise<void> {
  const creds = resolveCredentials(issueId);
  if (!creds) {
    log(`send(${issueId}): IM disabled or not configured`);
    return;
  }

  let topicId = getTopicId(issueId);
  if (!topicId) {
    topicId = await ensureTopic(creds, issueId);
  }
  if (!topicId) {
    log(`send(${issueId}): no topic, message dropped`);
    return;
  }

  log(`Sending to ${issueId} (topic ${topicId}): ${message.substring(0, 60)}...`);
  await tgApi(creds.token, "sendMessage", {
    chat_id: creds.chatId,
    message_thread_id: topicId,
    text: message,
    parse_mode: "HTML",
  });
}

async function closeTopic(issueId: string): Promise<void> {
  const creds = resolveCredentials(issueId);
  if (!creds) return;
  const topicId = getTopicId(issueId);
  if (!topicId) return;

  log(`Closing topic for ${issueId} (topic ${topicId})`);
  await tgApi(creds.token, "closeForumTopic", {
    chat_id: creds.chatId,
    message_thread_id: topicId,
  });
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

    // Migrate legacy topic:* entries from global config to agent meta
    try {
      const store = require("@/lib/store") as typeof import("@/lib/store");
      const appConfig = store.getConfig();
      const tgConfig = appConfig.integrations?.telegram?.config;
      if (tgConfig) {
        const topicKeys = Object.keys(tgConfig).filter((k) => k.startsWith("topic:"));
        if (topicKeys.length > 0) {
          for (const key of topicKeys) {
            const issueId = key.replace("topic:", "");
            const topicId = tgConfig[key];
            // Find agent and migrate
            for (const p of store.listProjects()) {
              if (store.getAgent(p.path, issueId)) {
                store.setAgentMeta(p.path, issueId, "telegram:topicId", topicId);
                break;
              }
            }
            delete tgConfig[key];
          }
          store.saveConfig(appConfig);
          ctx.log(`Migrated ${topicKeys.length} topic mappings from global config to agent meta`);
        }
      }
    } catch (err) {
      ctx.log(`Topic migration failed (non-critical): ${err}`);
    }

    ctx.log("Telegram integration registered");
  },

  async onAgentSpawned(event) {
    log(`onAgentSpawned: ${event.issueId}`);
    const creds = resolveCredentials(event.issueId, event.projectName);
    if (!creds) {
      log(`onAgentSpawned: IM disabled or not configured`);
      return;
    }
    const store = await import("@/lib/store");
    const project = store.getProjectByName(event.projectName);
    const agent = project ? store.getAgent(project.path, event.issueId) : null;
    const title = agent?.title || event.issueId;

    await ensureTopic(creds, event.issueId, `${event.issueId}: ${title}`);
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
    await closeTopic(event.issueId);
  },

  async onAgentPreview(event) {
    log(`onAgentPreview: ${event.issueId}`);
    let msg = "🔍 <b>Remote Preview</b>\n";
    if (event.previewUrl) {
      const urls = event.previewUrl.split(" , ");
      for (const url of urls) {
        msg += `🌐 ${url.trim()}\n`;
      }
    }
    if (event.supabaseUrl) msg += `🗄️ ${event.supabaseUrl}\n`;
    msg += `\n⏱ Dostępne przez 24h`;
    await send(event.issueId, msg);
  },

  async onAgentMerged(event) {
    log(`onAgentMerged: ${event.issueId}`);
    await send(event.issueId, "✅ Merged to master");
    await closeTopic(event.issueId);
  },

  async onAgentError(event) {
    // Logarithmic debounce: 1st instant, then 1min, 2min, 4min, 8min, ...
    const key = `${event.issueId}:${event.error.substring(0, 100)}`;
    const now = Date.now();
    const prev = _errorDebounce.get(key);
    if (prev) {
      const cooldown = Math.min(60_000 * Math.pow(2, prev.count - 1), 3_600_000); // cap at 1h
      if (now - prev.lastSent < cooldown) {
        log(`onAgentError: ${event.issueId} — SKIP (debounce, next in ${Math.round((cooldown - (now - prev.lastSent)) / 1000)}s)`);
        return;
      }
      prev.lastSent = now;
      prev.count++;
    } else {
      _errorDebounce.set(key, { lastSent: now, count: 1 });
    }
    log(`onAgentError: ${event.issueId} — ${event.error.substring(0, 80)}`);
    await send(event.issueId, `❌ Error: ${event.error.substring(0, 200)}`);
  },
};
