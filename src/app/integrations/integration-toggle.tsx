"use client";

import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";

export function IntegrationToggle({
  name,
  enabled,
  onToggle,
}: {
  name: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  async function toggle(checked: boolean) {
    try {
      const resp = await fetch("/api/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, enabled: checked }),
      });
      if (!resp.ok) throw new Error("Toggle failed");
      toast.success(checked ? "Enabled" : "Disabled");
      onToggle();
    } catch {
      toast.error("Failed to toggle");
    }
  }

  return <Switch checked={enabled} onCheckedChange={toggle} />;
}
