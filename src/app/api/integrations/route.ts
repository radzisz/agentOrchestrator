import { NextRequest, NextResponse } from "next/server";
import * as store from "@/lib/store";
import { getIntegration, getAllIntegrations } from "@/integrations/registry";
import type { IntegrationConfigField } from "@/integrations/types";

// Static schemas for built-in integrations — fallback when runtime registry
// hasn't loaded yet (Next.js may evaluate API routes before instrumentation finishes)
const BUILTIN_SCHEMAS: Record<string, { displayName: string; configSchema: IntegrationConfigField[] }> = {
  linear: {
    displayName: "Linear",
    configSchema: [
      { key: "pollInterval", label: "Poll Interval", type: "select", required: true, description: "How often to poll Linear for issue updates", default: "60000", options: [{ label: "1 min", value: "60000" }, { label: "5 min", value: "300000" }, { label: "30 min", value: "1800000" }, { label: "60 min", value: "3600000" }] },
    ],
  },
  github: {
    displayName: "GitHub",
    configSchema: [
      { key: "defaultToken", label: "Default GitHub Token", type: "secret", required: true, description: "Personal access token. Used as default for new projects." },
    ],
  },
  telegram: {
    displayName: "Telegram",
    configSchema: [
      { key: "botToken", label: "Bot Token", type: "secret", required: true, description: "Telegram Bot Token from @BotFather" },
      { key: "chatId", label: "Chat ID", type: "string", required: true, description: "Telegram Group Chat ID (with Forum Mode ON)" },
    ],
  },
  sentry: {
    displayName: "Sentry",
    configSchema: [
      { key: "authToken", label: "Auth Token", type: "secret", required: true, description: "Sentry Auth Token (sntryu_...)" },
      { key: "org", label: "Organization", type: "string", required: true, description: "Sentry organization slug" },
      { key: "webhookSecret", label: "Webhook Secret", type: "secret", required: false, description: "Shared secret for webhook signature verification (optional)" },
    ],
  },
  "local-drive": {
    displayName: "Local Drive",
    configSchema: [
      { key: "basePath", label: "Projects Base Path", type: "string", required: true, description: "Root directory where all project repos live (e.g. D:/git)", default: "D:/git" },
    ],
  },
};

export async function GET() {
  try {
    const appConfig = store.getConfig();
    const integrations = Object.entries(appConfig.integrations).map(([name, data]) => {
      // Try runtime registry first, fall back to static schema
      const registered = getIntegration(name);
      const builtin = BUILTIN_SCHEMAS[name];
      const schema = registered?.integration.configSchema || builtin?.configSchema || [];
      const displayName = registered?.integration.displayName || builtin?.displayName || name.charAt(0).toUpperCase() + name.slice(1);
      const config = data.config || {};

      // Active = all required config fields have non-empty values
      const requiredFields = schema.filter((f) => f.required);
      const active = requiredFields.length === 0 || requiredFields.every(
        (f) => {
          const val = config[f.key];
          return val !== undefined && val !== null && val !== "";
        }
      );

      return {
        name,
        displayName,
        enabled: data.enabled,
        active,
        builtIn: name in BUILTIN_SCHEMAS,
        configSchema: schema,
        configs: Object.entries(config).map(([key, value]) => ({
          key,
          value,
        })),
      };
    });
    return NextResponse.json(integrations);
  } catch (error) {
    console.error("[api/integrations] GET error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { name, enabled, configs } = body;

  const appConfig = store.getConfig();
  if (!appConfig.integrations[name]) {
    appConfig.integrations[name] = { enabled: true, config: {} };
  }

  if (typeof enabled === "boolean") {
    appConfig.integrations[name].enabled = enabled;
  }

  if (configs && typeof configs === "object") {
    if (!appConfig.integrations[name].config) {
      appConfig.integrations[name].config = {};
    }
    for (const [key, value] of Object.entries(configs)) {
      appConfig.integrations[name].config![key] = String(value);
    }
  }

  store.saveConfig(appConfig);

  return NextResponse.json({ success: true });
}
