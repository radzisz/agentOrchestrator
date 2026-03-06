"use client";

import { ServicesCard } from "./services-card";

interface ServiceConfig {
  name: string;
  cmd: string;
  port: number;
}

export function AgentCards({
  projectName,
  issueId,
  branch,
  runtimeId,
  cfgServices,
  initialServicesEnabled,
  onShowLogs,
}: {
  projectName: string;
  issueId: string;
  branch: string;
  runtimeId: string;
  cfgServices: ServiceConfig[];
  initialServicesEnabled: boolean;
  onShowLogs?: () => void;
}) {
  return (
    <ServicesCard
      projectName={projectName}
      issueId={issueId}
      branch={branch}
      runtimeId={runtimeId}
      cfgServices={cfgServices}
      initialEnabled={initialServicesEnabled}
      onShowLogs={onShowLogs}
    />
  );
}
