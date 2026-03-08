"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Send, Trash2, StopCircle, RotateCcw } from "lucide-react";
import { useAgentState } from "./agent-state-context";

interface ChatMessage {
  role: "human" | "agent";
  text: string;
  ts: string;
}

/** Map of Linear CDN image URLs to local proxy filenames (populated on first encounter). */
const imageProxyCache = new Map<string, string>();
let imageProxyCounter = 0;

/**
 * Resolve an image URL for display in the browser.
 * - uploads.linear.app URLs → proxy through our API (requires auth)
 * - .10timesdev/images/* local paths → serve through our API
 * - Other URLs → pass through
 */
function resolveImageUrl(url: string, projectName: string, agentId: string): string {
  // Already our API path
  if (url.startsWith("/api/")) return url;
  // Local path from TASK.md style
  if (url.startsWith(".10timesdev/images/")) {
    const filename = url.split("/").pop() || "";
    return `/api/projects/${projectName}/agents/${agentId}/images/${filename}`;
  }
  // Linear CDN — needs auth, proxy through our image API
  if (url.includes("uploads.linear.app")) {
    let filename = imageProxyCache.get(url);
    if (!filename) {
      imageProxyCounter++;
      const ext = url.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)?.[0] || ".png";
      filename = `img-${imageProxyCounter}${ext}`;
      imageProxyCache.set(url, filename);
    }
    return `/api/projects/${projectName}/agents/${agentId}/images/${filename}`;
  }
  return url;
}

/** Render text with markdown images as <img> (clickable lightbox) and bold as <strong>. */
function renderMessageContent(
  text: string,
  projectName: string,
  agentId: string,
  onImageClick: (src: string) => void,
) {
  // Split text by markdown image pattern ![alt](url) and bold **text**
  const parts = text.split(/(!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    // Markdown image
    const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      const src = resolveImageUrl(imgMatch[2], projectName, agentId);
      return (
        <img
          key={i}
          src={src}
          alt={imgMatch[1] || "image"}
          className="max-w-full max-h-80 rounded my-1 cursor-pointer hover:opacity-80"
          loading="lazy"
          onClick={() => onImageClick(src)}
        />
      );
    }
    // Bold
    const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
    if (boldMatch) {
      return <strong key={i}>{boldMatch[1]}</strong>;
    }
    return part;
  });
}

interface AgentChatProps {
  agentId: string;
  projectName: string;
}

export function AgentChat({ agentId, projectName }: AgentChatProps) {
  const { uiStatus: ui } = useAgentState();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [liveOutput, setLiveOutput] = useState("");
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Poll messages (lightweight — disk read only, no docker/git)
  useEffect(() => {
    async function fetchMessages() {
      try {
        const resp = await fetch(`/api/projects/${projectName}/agents/${agentId}/messages`);
        const data = await resp.json();
        if (data.messages) setMessages(data.messages);
      } catch {}
    }

    fetchMessages();
    const interval = setInterval(fetchMessages, 5000);
    window.addEventListener("agent-state-changed", fetchMessages);
    return () => {
      clearInterval(interval);
      window.removeEventListener("agent-state-changed", fetchMessages);
    };
  }, [agentId, projectName]);

  // Derived states from uiStatus
  const isRunning = ui.status === "running";
  const isStarting = ui.status === "starting";
  const isClosing = ui.status === "closing";
  const isActive = isRunning || isStarting;

  // Poll live output when agent is running
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
      // Trigger immediate poll in header and other components
      window.dispatchEvent(new Event("agent-state-changed"));
    } finally {
      setSending(false);
    }
  }, [input, sending, agentId, isRunning]);

  // Force interrupt: stop agent process
  const [stopping, setStopping] = useState(false);
  async function handleInterrupt() {
    setStopping(true);
    try {
      setLiveOutput("");
      await fetch(`/api/agents/${agentId}/stop`, { method: "POST" });
      window.dispatchEvent(new Event("agent-state-changed"));
    } catch {} finally {
      setStopping(false);
    }
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
              <div className="text-sm whitespace-pre-wrap break-words">{renderMessageContent(msg.text, projectName, agentId, setLightboxSrc)}</div>
            </div>
          </div>
        ))}

        {/* Live status bubble — starting, running, or closing */}
        {(isActive || isClosing) && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-2 max-w-[90%]">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <span className="relative flex h-2 w-2">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${
                    isClosing ? "bg-red-400" : isStarting ? "bg-yellow-400" : "bg-green-400"
                  } opacity-75`} />
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${
                    isClosing ? "bg-red-500" : isStarting ? "bg-yellow-500" : "bg-green-500"
                  }`} />
                </span>
                {isClosing ? "Agent is stopping..." : isStarting ? "Agent is starting..." : "Agent is working..."}
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
        {/* Action bar when active */}
        {isActive && (
          <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
            <span className="flex-1">{isStarting ? "Agent is starting — messages will be queued." : "Agent is running — messages will be queued for when it finishes."}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] px-2 text-destructive hover:text-destructive"
              onClick={handleInterrupt}
              disabled={stopping || isClosing}
            >
              <StopCircle className="h-3 w-3 mr-1" />
              {stopping ? "Stopping..." : "Stop"}
            </Button>
          </div>
        )}

        {/* Closing indicator */}
        {isClosing && (
          <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
            <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full" />
            <span>Stopping agent...</span>
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
              disabled={sending || !input.trim() || isClosing}
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

      {/* Image lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl font-bold"
            onClick={() => setLightboxSrc(null)}
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
