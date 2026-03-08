"use client";

import { useEffect, useState } from "react";

function Spinner() {
  return (
    <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function ServiceLink({ name, port, runtimeId, healthPath }: { name: string; port: number; runtimeId: string; healthPath?: string }) {
  const [status, setStatus] = useState<"loading" | "up" | "down">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const params = new URLSearchParams({ port: String(port), runtimeId, service: name });
        if (healthPath) params.set("healthPath", healthPath);
        const resp = await fetch(`/api/health?${params}`);
        const data = await resp.json();
        if (cancelled) return;
        if (data.error) {
          setStatus("down");
          setErrorMsg(data.error);
        } else if (data.up) {
          setStatus("up");
          setErrorMsg(null);
        } else {
          setStatus("loading");
        }
      } catch {
        // ignore network errors
      }
    }

    check();
    const interval = setInterval(check, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [port, runtimeId, name, healthPath]);

  if (status === "down") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600 text-white text-xs font-mono cursor-help"
        title={errorMsg || "Service not responding"}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-300" />
        {name}:{port}
      </span>
    );
  }

  if (status === "loading") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-600 text-white text-xs font-mono cursor-default"
        title={`Waiting for ${name} on port ${port}`}>
        <Spinner />
        {name}:{port}
      </span>
    );
  }

  return (
    <a
      href={`http://localhost:${port}${healthPath || ""}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-600 hover:bg-green-500 text-white text-xs font-mono transition-colors"
      title={`${name} listening on port ${port}`}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse" />
      {name}:{port}
    </a>
  );
}
