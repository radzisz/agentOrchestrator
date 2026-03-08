// ---------------------------------------------------------------------------
// IM Provider contract — abstract base class for messaging integrations
// ---------------------------------------------------------------------------

import type { ProviderTypeSchema } from "./config-schema";

export abstract class BaseIMProvider {
  abstract readonly name: string;
  abstract readonly schema: ProviderTypeSchema;

  abstract send(config: Record<string, string>, issueId: string, message: string): Promise<void>;

  async ensureTopic?(config: Record<string, string>, issueId: string, title: string): Promise<string | null>;
  async closeTopic?(config: Record<string, string>, issueId: string): Promise<void>;
}
