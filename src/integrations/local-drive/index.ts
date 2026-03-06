import type { Integration, IntegrationContext } from "../types";

/**
 * Local Drive integration — configures the base path where all project
 * repositories are cloned / stored on disk.
 */

let ctx: IntegrationContext | null = null;

export const localDriveIntegration: Integration = {
  name: "local-drive",
  displayName: "Local Drive",
  configSchema: [
    {
      key: "basePath",
      label: "Projects Base Path",
      type: "string",
      required: true,
      description: "Root directory where all project repos live (e.g. D:/git)",
      default: "D:/git",
    },
  ],

  async onRegister(context) {
    ctx = context;

    const existing = await ctx.getConfig("basePath");
    if (existing === null) {
      await ctx.setConfig("basePath", "D:/git");
    }

    ctx.log("Local Drive integration registered");
  },
};

/**
 * Get the configured base path for project repositories.
 */
export async function getBasePath(): Promise<string> {
  if (!ctx) return "D:/git";
  const val = await ctx.getConfig("basePath");
  return val || "D:/git";
}
