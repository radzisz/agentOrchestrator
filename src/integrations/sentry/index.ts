import type { Integration, IntegrationContext } from "../types";

/**
 * Sentry integration — forwards Sentry alerts to Linear as new issues.
 *
 * How it works:
 * 1. Sentry sends webhook alerts to /api/webhooks/sentry
 * 2. Webhook resolves which orchestrator project owns the Sentry project
 *    (via Project.sentryProjects mapping)
 * 3. Creates a Linear issue in that project's team with the "agent" label
 * 4. The dispatcher picks it up and spawns an agent to fix the bug
 *
 * Configuration (global):
 *   - authToken: Sentry auth token (for API calls)
 *   - org: Sentry organization slug
 *   - webhookSecret: shared secret for verifying webhook signatures
 *
 * Per-project mapping is done in Project settings (sentryProjects field).
 */

let ctx: IntegrationContext | null = null;

export const sentryIntegration: Integration = {
  name: "sentry",
  displayName: "Sentry → Linear",
  configSchema: [
    {
      key: "authToken",
      label: "Auth Token",
      type: "secret",
      required: true,
      description: "Sentry Auth Token (sntryu_...)",
    },
    {
      key: "org",
      label: "Organization",
      type: "string",
      required: true,
      description: "Sentry organization slug",
    },
    {
      key: "webhookSecret",
      label: "Webhook Secret",
      type: "secret",
      required: false,
      description: "Shared secret for webhook signature verification (optional)",
    },
  ],

  async onRegister(context) {
    ctx = context;

    for (const key of ["authToken", "org", "webhookSecret"]) {
      const existing = await ctx.getConfig(key);
      if (existing === null) {
        await ctx.setConfig(key, "");
      }
    }

    ctx.log("Sentry integration registered — forwards Sentry issues to Linear");
  },
};

export function getContext(): IntegrationContext | null {
  return ctx;
}
