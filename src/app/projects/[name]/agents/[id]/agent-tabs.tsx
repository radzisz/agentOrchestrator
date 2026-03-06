"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentChat } from "./agent-chat";
import { AgentLogs } from "@/components/agent-logs";
import { CodeTab } from "./code-tab";

interface AgentTabsProps {
  agentId: string;
  projectName: string;
  uiStatus: { status: string; reason?: string };
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function AgentTabs({ agentId, projectName, uiStatus, activeTab, onTabChange }: AgentTabsProps) {
  return (
    <Tabs value={activeTab} onValueChange={onTabChange} className="flex flex-col flex-1 min-h-0">
      <TabsList className="shrink-0">
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="code">Code</TabsTrigger>
        <TabsTrigger value="logs">Logs</TabsTrigger>
      </TabsList>
      <TabsContent value="chat" forceMount className="flex-1 min-h-0 mt-4" hidden={activeTab !== "chat"}>
        <AgentChat agentId={agentId} projectName={projectName} uiStatus={uiStatus as any} />
      </TabsContent>
      <TabsContent value="code" className="flex-1 min-h-0 mt-4 overflow-y-auto">
        <CodeTab projectName={projectName} issueId={agentId} />
      </TabsContent>
      <TabsContent value="logs" className="flex-1 min-h-0 mt-4 overflow-y-auto">
        <AgentLogs agentId={agentId} />
      </TabsContent>
    </Tabs>
  );
}
