"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface NetlifySite {
  name: string;     // service name, e.g. "guide", "panel", "admin"
  siteName: string; // netlify site name, e.g. "ukryteskarby-guide"
}

export interface RemoteConfigData {
  supabaseAccessToken: string | null;
  supabaseProjectRef: string | null;
  netlifyAuthToken: string | null;
  netlifySites: NetlifySite[];
}

export function RemoteConfig({
  projectName,
  initialData,
  enabled,
  onToggle,
}: {
  projectName: string;
  initialData: RemoteConfigData;
  enabled: boolean;
  onToggle: () => void;
}) {
  const [data, setData] = useState<RemoteConfigData>(initialData);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const resp = await fetch(`/api/projects/${projectName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supabaseAccessToken: data.supabaseAccessToken || null,
          supabaseProjectRef: data.supabaseProjectRef || null,
          netlifyAuthToken: data.netlifyAuthToken || null,
          netlifySites: data.netlifySites.length > 0 ? data.netlifySites : null,
        }),
      });
      if (!resp.ok) throw new Error("Save failed");
      toast.success("Remote config saved");
      setOpen(false);
    } catch {
      toast.error("Failed to save remote config");
    } finally {
      setSaving(false);
    }
  }

  function updateSite(idx: number, field: keyof NetlifySite, value: string) {
    const updated = [...data.netlifySites];
    updated[idx] = { ...updated[idx], [field]: value };
    setData({ ...data, netlifySites: updated });
  }

  function addSite() {
    setData({
      ...data,
      netlifySites: [...data.netlifySites, { name: "", siteName: "" }],
    });
  }

  function removeSite(idx: number) {
    setData({
      ...data,
      netlifySites: data.netlifySites.filter((_, i) => i !== idx),
    });
  }

  const hasSupabase = initialData.supabaseProjectRef || initialData.supabaseAccessToken;
  const hasNetlify = initialData.netlifySites.length > 0;

  if (!open) {
    return (
      <Card className={!enabled ? "opacity-50" : ""}>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className={`w-8 h-4 rounded-full transition-colors relative ${enabled ? "bg-green-500" : "bg-muted"}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? "left-4" : "left-0.5"}`} />
            </button>
            <CardTitle className="text-sm">Remote</CardTitle>
          </div>
          {enabled && (
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              {hasSupabase || hasNetlify ? "Edit" : "Configure"}
            </Button>
          )}
        </CardHeader>
        {enabled && (hasSupabase || hasNetlify) && (
          <CardContent className="pt-0">
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>Supabase: {initialData.supabaseProjectRef || "Not set"}</div>
              <div>Supabase Token: {initialData.supabaseAccessToken ? "***" : "Not set"}</div>
              <div>Netlify Token: {initialData.netlifyAuthToken ? "***" : "Not set"}</div>
              {initialData.netlifySites.length > 0 && (
                <div>
                  Sites:{" "}
                  {initialData.netlifySites
                    .map((s) => `${s.name} (${s.siteName})`)
                    .join(", ")}
                </div>
              )}
            </div>
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 py-3">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className={`w-8 h-4 rounded-full transition-colors relative ${enabled ? "bg-green-500" : "bg-muted"}`}
        >
          <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? "left-4" : "left-0.5"}`} />
        </button>
        <CardTitle className="text-sm">Remote</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Supabase section */}
        <div>
          <label className="text-xs font-medium block mb-2">Supabase</label>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Project Ref
              </label>
              <input
                className="w-full px-2 py-1 text-sm border rounded bg-background"
                value={data.supabaseProjectRef || ""}
                onChange={(e) =>
                  setData({ ...data, supabaseProjectRef: e.target.value })
                }
                placeholder="abcdefghijklmnop"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Access Token
              </label>
              <input
                className="w-full px-2 py-1 text-sm border rounded bg-background font-mono"
                type="password"
                value={data.supabaseAccessToken || ""}
                onChange={(e) =>
                  setData({ ...data, supabaseAccessToken: e.target.value })
                }
                placeholder="sbp_..."
              />
            </div>
          </div>
        </div>

        {/* Netlify section */}
        <div>
          <label className="text-xs font-medium block mb-2">Netlify</label>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Auth Token
              </label>
              <input
                className="w-full px-2 py-1 text-sm border rounded bg-background font-mono"
                type="password"
                value={data.netlifyAuthToken || ""}
                onChange={(e) =>
                  setData({ ...data, netlifyAuthToken: e.target.value })
                }
                placeholder="nfp_..."
              />
            </div>

            {/* Sites list */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted-foreground">Sites</label>
                <Button variant="ghost" size="sm" onClick={addSite}>
                  + Add
                </Button>
              </div>
              <div className="space-y-2">
                {data.netlifySites.map((site, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-[1fr_2fr_auto] gap-2 items-center"
                  >
                    <input
                      className="px-2 py-1 text-sm border rounded bg-background"
                      value={site.name}
                      onChange={(e) => updateSite(idx, "name", e.target.value)}
                      placeholder="service name"
                    />
                    <input
                      className="px-2 py-1 text-sm border rounded bg-background font-mono"
                      value={site.siteName}
                      onChange={(e) => updateSite(idx, "siteName", e.target.value)}
                      placeholder="netlify-site-name"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeSite(idx)}
                      className="text-destructive px-2"
                    >
                      x
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setData(initialData);
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
