"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { AgentStateData } from "./agent-state-panel";

interface UiStatus {
  status: "starting" | "running" | "awaiting" | "closing" | "closed";
  reason?: "completed" | "error" | "conflict";
}

interface CurrentOp {
  name: string;
  startedAt: string;
  progress?: string;
}

interface AgentStateContextValue {
  state: AgentStateData;
  uiStatus: UiStatus;
  currentOp: CurrentOp | null;
  refreshNow: () => void;
}

const AgentStateContext = createContext<AgentStateContextValue | null>(null);

interface AgentStateProviderProps {
  issueId: string;
  initialState: AgentStateData;
  initialUiStatus: UiStatus;
  initialCurrentOp: CurrentOp | null;
  children: React.ReactNode;
}

export function AgentStateProvider({
  issueId,
  initialState,
  initialUiStatus,
  initialCurrentOp,
  children,
}: AgentStateProviderProps) {
  const [state, setState] = useState<AgentStateData>(initialState);
  const [uiStatus, setUiStatus] = useState<UiStatus>(initialUiStatus);
  const [currentOp, setCurrentOp] = useState<CurrentOp | null>(initialCurrentOp);

  const poll = useCallback(async () => {
    try {
      const resp = await fetch(`/api/agents/${issueId}/state`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.state) setState(data.state);
      if (data.uiStatus) setUiStatus(data.uiStatus);
      setCurrentOp(data.currentOperation ?? null);
    } catch {
      // ignore
    }
  }, [issueId]);

  useEffect(() => {
    const interval = setInterval(poll, 3000);
    window.addEventListener("agent-state-changed", poll);
    return () => {
      clearInterval(interval);
      window.removeEventListener("agent-state-changed", poll);
    };
  }, [poll]);

  const refreshNow = useCallback(() => {
    poll();
  }, [poll]);

  return (
    <AgentStateContext.Provider value={{ state, uiStatus, currentOp, refreshNow }}>
      {children}
    </AgentStateContext.Provider>
  );
}

export function useAgentState(): AgentStateContextValue {
  const ctx = useContext(AgentStateContext);
  if (!ctx) throw new Error("useAgentState must be used within AgentStateProvider");
  return ctx;
}
