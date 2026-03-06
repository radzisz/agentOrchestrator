import type { Integration, IntegrationContext } from "../types";

/**
 * Linear integration — manages the polling connection to Linear.
 * Credentials (apiKey, teamKey, label) are configured per-project in Project settings.
 * Only pollInterval is global and managed here.
 */

let ctx: IntegrationContext | null = null;

export const linearIntegration: Integration = {
  name: "linear",
  displayName: "Linear",
  configSchema: [
    {
      key: "pollInterval",
      label: "Poll Interval",
      type: "select",
      required: true,
      description: "How often to poll Linear for issue updates",
      default: "60000",
      options: [
        { label: "1 minute", value: "60000" },
        { label: "5 minutes", value: "300000" },
        { label: "30 minutes", value: "1800000" },
        { label: "60 minutes", value: "3600000" },
      ],
    },
  ],

  async onRegister(context) {
    ctx = context;

    const existing = await ctx.getConfig("pollInterval");
    if (existing === null) {
      await ctx.setConfig("pollInterval", "60000");
    }

    ctx.log("Linear integration registered");
  },
};

/**
 * Get the configured poll interval in milliseconds.
 * Called by the dispatcher to determine polling frequency.
 */
export async function getPollInterval(): Promise<number> {
  if (!ctx) return 60000;
  const val = await ctx.getConfig("pollInterval");
  return val ? parseInt(val) : 60000;
}
