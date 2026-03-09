"use client";

import { useState, useEffect, useCallback } from "react";
import { AgentTabs } from "./agent-tabs";

const VALID_TABS = new Set(["chat", "code", "logs"]);

interface AgentContentProps {
  projectName: string;
  issueId: string;
}

export function AgentContent({
  projectName,
  issueId,
}: AgentContentProps) {
  const [activeTab, setActiveTab] = useState("chat");

  const changeTab = useCallback((tab: string) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
  }, []);

  // Sync tab from URL hash after hydration (avoids SSR mismatch)
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (VALID_TABS.has(h)) setActiveTab(h);
  }, []);

  useEffect(() => {
    function handleShowLogs() { changeTab("logs"); }
    function handleShowCode() { changeTab("code"); }
    function handleShowChat() { changeTab("chat"); }
    window.addEventListener("show-logs", handleShowLogs);
    window.addEventListener("show-code", handleShowCode);
    window.addEventListener("show-chat", handleShowChat);
    return () => {
      window.removeEventListener("show-logs", handleShowLogs);
      window.removeEventListener("show-code", handleShowCode);
      window.removeEventListener("show-chat", handleShowChat);
    };
  }, [changeTab]);

  return (
    <div className="p-6 h-full flex flex-col">
      <AgentTabs
        agentId={issueId}
        projectName={projectName}
        activeTab={activeTab}
        onTabChange={changeTab}
      />
    </div>
  );
}
