import type { Integration, IntegrationContext } from "../types";

/**
 * GitHub integration — global GitHub token used as default for new projects.
 * Per-project tokens can override this in project settings.
 */

let ctx: IntegrationContext | null = null;

export const githubIntegration: Integration = {
  name: "github",
  displayName: "GitHub",
  configSchema: [
    {
      key: "defaultToken",
      label: "Default GitHub Token",
      type: "secret",
      required: true,
      description: "Personal access token (classic) or fine-grained token. Used as default for new projects.",
    },
  ],

  async onRegister(context) {
    ctx = context;
    ctx.log("GitHub integration registered");
  },
};

/**
 * Get the global default GitHub token.
 */
export async function getDefaultGithubToken(): Promise<string | null> {
  if (!ctx) return null;
  return ctx.getConfig("defaultToken");
}
