"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Send, Trash2, StopCircle, RotateCcw } from "lucide-react";

interface ChatMessage {
  role: "human" | "agent";
  text: string;
  ts: string;
}

interface UiStatus {
  status: "starting" | "running" | "awaiting" | "closing" | "closed";
  reason?: "completed" | "error" | "conflict";
}

interface AgentChatProps {
  agentId: string;
  projectName: string;
  uiStatus: UiStatus;
}

export function AgentChat({ agentId, projectName, uiStatus: initialUiStatus }: AgentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ui, setUi] = useState<UiStatus>(initialUiStatus);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [liveOutput, setLiveOutput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Poll messages + status
  useEffect(() => {
    async function fetchMessages() {
      try {
        const resp = await fetch(`/api/projects/${projectName}/agents/${agentId}/messages`);
        const data = await resp.json();
        if (data.messages) setMessages(data.messages);
        if (data.uiStatus) setUi(data.uiStatus);
      } catch {}
    }

    fetchMessages();
    const interval = setInterval(fetchMessages, 5000);
    return () => clearInterval(interval);
  }, [agentId, projectName]);

  // Poll live output when agent is running
  const isRunning = ui.status === "running";

  useEffect(() => {
    if (!isRunning) {
      setLiveOutput("");
      return;
    }

    async function fetchOutput() {
      try {
        const resp = await fetch(`/api/agents/${agentId}/output?tail=30`);
        const data = await resp.json();
        setLiveOutput(data.output || "");
      } catch {}
    }

    fetchOutput();
    const interval = setInterval(fetchOutput, 3000);
    return () => clearInterval(interval);
  }, [agentId, isRunning]);

  // Auto-scroll on new messages or live output changes
  const prevCountRef = useRef(messages.length);
  const prevOutputRef = useRef("");

  useEffect(() => {
    const newMessages = messages.length > prevCountRef.current;
    const newOutput = liveOutput !== prevOutputRef.current;
    if (newMessages || newOutput) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    prevCountRef.current = messages.length;
    prevOutputRef.current = liveOutput;
  }, [messages.length, liveOutput]);

  // Send message (queue if running, wake if stopped)
  const handleSend = useCallback(async (force = false) => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);

    // Optimistic update
    setMessages(prev => [...prev, { role: "human", text, ts: new Date().toISOString() }]);
    setInput("");

    try {
      await fetch(`/api/agents/${agentId}/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, force }),
      });
    } finally {
      setSending(false);
    }
  }, [input, sending, agentId]);

  // Force interrupt: stop + wake fresh
  async function handleInterrupt() {
    try {
      await fetch(`/api/agents/${agentId}/stop`, { method: "POST" });
    } catch {}
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(false);
    }
  }

  async function deleteMessage(index: number) {
    try {
      await fetch(`/api/projects/${projectName}/agents/${agentId}/messages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      setMessages(prev => prev.filter((_, i) => i !== index));
    } catch {}
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground text-sm py-8">
            No messages yet. Send a message to start the conversation.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex gap-1 group ${msg.role === "human" ? "justify-end" : "justify-start"}`}
          >
            {msg.role === "human" && (
              <button
                onClick={() => deleteMessage(i)}
                className="self-start mt-2 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                title="Delete message"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                msg.role === "human"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              }`}
            >
              <div className="text-xs opacity-60 mb-1">
                {msg.role === "human" ? "You" : "Agent"}{" "}
                <span>{new Date(msg.ts).toLocaleTimeString()}</span>
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">{msg.text}</div>
            </div>
          </div>
        ))}

        {/* Live output while agent is running */}
        {isRunning && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-2 max-w-[90%]">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                Agent is working...
              </div>
              {liveOutput && (
                <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-auto font-mono leading-relaxed">
                  {liveOutput}
                </pre>
              )}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="border-t px-4 py-3">
        {/* Action bar when running */}
        {isRunning && (
          <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
            <span className="flex-1">Agent is running — messages will be queued for when it finishes.</span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] px-2 text-destructive hover:text-destructive"
              onClick={handleInterrupt}
            >
              <StopCircle className="h-3 w-3 mr-1" />
              Stop
            </Button>
          </div>
        )}

        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? "Queue a message for the agent..." : "Send a message to the agent..."}
            rows={1}
            className="flex-1 bg-transparent text-sm border border-border rounded px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {isRunning && input.trim() ? (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleSend(false)}
                disabled={sending || !input.trim()}
                title="Queue message (agent will see it when done)"
              >
                <Send className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => handleSend(true)}
                disabled={sending || !input.trim()}
                title="Interrupt agent and send now"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              onClick={() => handleSend(false)}
              disabled={sending || !input.trim()}
            >
              {sending ? (
                <span className="text-xs">Sending...</span>
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
