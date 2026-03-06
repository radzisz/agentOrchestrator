"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IntegrationConfigEditor } from "./integration-config";
import { IntegrationLogs } from "./integration-logs";
import { ChevronDown, ChevronRight } from "lucide-react";

interface ConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret" | "select";
  required?: boolean;
  description?: string;
  default?: string;
  options?: Array<{ label: string; value: string }>;
}

interface IntegrationData {
  name: string;
  displayName: string;
  enabled: boolean;
  active: boolean;
  builtIn: boolean;
  configSchema: ConfigField[];
  configs: Array<{ key: string; value: string }>;
}

interface ProjectInfo {
  name: string;
  linearTeamKey: string;
  linearLabel: string;
  hasApiKey: boolean;
  sentryProjects: string[];
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationData[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [integResp, projResp] = await Promise.all([
        fetch("/api/integrations"),
        fetch("/api/projects"),
      ]);
      const integData = await integResp.json();
      const projData = await projResp.json();
      if (integResp.ok && Array.isArray(integData)) {
        setIntegrations(integData);
      } else {
        setError(integData.error || `HTTP ${integResp.status}`);
      }
      if (projResp.ok && Array.isArray(projData)) {
        setProjects(projData.map((p: any) => ({
          name: p.name,
          linearTeamKey: p.linearTeamKey || p.config?.LINEAR_TEAM_KEY || "",
          linearLabel: p.linearLabel || p.config?.LINEAR_LABEL || "agent",
          hasApiKey: !!p.config?.LINEAR_API_KEY,
          sentryProjects: (p.sentryProjects as string[]) || [],
        })));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading integrations...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Error: {error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="sticky top-0 z-10 bg-background px-6 py-3 border-b border-border">
        <h1 className="text-2xl font-bold">Integrations</h1>
      </div>

      <div className="p-6 space-y-4">
        {integrations.map((integ) => {
          const isOpen = expanded[integ.name] ?? false;
          const requiredFields = integ.configSchema.filter((f) => f.required);
          const missingFields = requiredFields.filter(
            (f) => !integ.configs.find((c) => c.key === f.key && c.value)
          );

          return (
            <Card key={integ.name}>
              <CardHeader
                className="cursor-pointer select-none"
                onClick={() => setExpanded((prev) => ({ ...prev, [integ.name]: !isOpen }))}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <CardTitle>{integ.displayName}</CardTitle>
                    {integ.builtIn && <Badge variant="secondary" className="text-[10px]">Built-in</Badge>}

                    {/* Collapsed summary: missing config hint */}
                    {!isOpen && !integ.active && missingFields.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        Missing: {missingFields.map((f) => f.label).join(", ")}
                      </span>
                    )}
                  </div>
                  {/* Status badge — right side */}
                  {integ.active ? (
                    <Badge className="bg-green-600 text-white border-0 text-xs px-2.5">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs border-yellow-600 text-yellow-400 px-2.5">
                      Inactive
                    </Badge>
                  )}
                </div>
              </CardHeader>

              {isOpen && (
                <CardContent className="space-y-4 pt-0">
                  <IntegrationConfigEditor
                    name={integ.name}
                    configs={integ.configs}
                    schema={integ.configSchema}
                    onSave={load}
                  />

                  {/* Linear: per-project credentials */}
                  {integ.name === "linear" && projects.length > 0 && (
                    <div className="border-t border-border pt-3 mt-3">
                      <p className="text-xs text-muted-foreground mb-2">
                        Credentials configured per project:
                      </p>
                      <div className="space-y-1.5">
                        {projects.map((p) => (
                          <a
                            key={p.name}
                            href={`/projects/${p.name}`}
                            className="flex items-center gap-3 text-sm hover:bg-accent rounded px-2 py-1 -mx-2"
                          >
                            <span className="font-medium">{p.name}</span>
                            <span className="text-muted-foreground font-mono text-xs">
                              team={p.linearTeamKey}
                            </span>
                            <span className="text-muted-foreground font-mono text-xs">
                              label={p.linearLabel}
                            </span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${p.hasApiKey ? "border-green-600 text-green-400" : "border-red-600 text-red-400"}`}
                            >
                              {p.hasApiKey ? "API Key set" : "No API Key"}
                            </Badge>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Sentry: per-project mapping */}
                  {integ.name === "sentry" && projects.length > 0 && (
                    <div className="border-t border-border pt-3 mt-3">
                      <p className="text-xs text-muted-foreground mb-1">
                        Forwards Sentry issues to Linear (creates issues with &quot;agent&quot; label).
                      </p>
                      <p className="text-xs text-muted-foreground mb-3">
                        Webhook URL: <code className="bg-muted px-1 rounded">/api/webhooks/sentry</code>
                      </p>
                      <p className="text-xs text-muted-foreground mb-2">
                        Sentry project mapping (configured per project):
                      </p>
                      <div className="space-y-1.5">
                        {projects.map((p) => (
                          <a
                            key={p.name}
                            href={`/projects/${p.name}`}
                            className="flex items-center gap-3 text-sm hover:bg-accent rounded px-2 py-1 -mx-2"
                          >
                            <span className="font-medium">{p.name}</span>
                            {p.sentryProjects.length > 0 ? (
                              <span className="text-muted-foreground font-mono text-xs">
                                {p.sentryProjects.join(", ")}
                              </span>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-[10px] border-yellow-600 text-yellow-400"
                              >
                                No mapping
                              </Badge>
                            )}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  <IntegrationLogs name={integ.name} />
                </CardContent>
              )}
            </Card>
          );
        })}

        {integrations.length === 0 && (
          <p className="text-muted-foreground text-center py-10">
            No integrations registered yet. They will appear after first startup.
          </p>
        )}
      </div>
    </div>
  );
}
