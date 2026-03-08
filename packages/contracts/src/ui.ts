// ---------------------------------------------------------------------------
// UI component prop types — for integration packages that export custom panels
// ---------------------------------------------------------------------------

import type { ConfigField } from "./config-schema";

export interface SystemConfigPanelProps {
  instanceConfig: Record<string, string>;
  onChange: (config: Record<string, string>) => void;
  schema: ConfigField[];
}

export interface ProjectConfigPanelProps {
  overrideFields: ConfigField[];
  overrides: Record<string, string>;
  resolvedConfig: Record<string, string>;
  projectName: string;
  setField: (key: string, value: string) => void;
  setFields: (patch: Record<string, string>) => void;
}
