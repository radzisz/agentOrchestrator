import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "../event-bus.js";

describe("TypedEventBus", () => {
  it("emits and receives events", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("agent:spawned", handler);
    bus.emit("agent:spawned", {
      agentId: "TEST-1",
      issueId: "TEST-1",
      projectName: "proj",
      containerName: "agent-TEST-1",
      branch: "agent/TEST-1",
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ agentId: "TEST-1" }));
  });

  it("supports multiple listeners", () => {
    const bus = new TypedEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("agent:error", h1);
    bus.on("agent:error", h2);
    bus.emit("agent:error", { agentId: "A", issueId: "A", error: "boom" });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("removes listeners with off()", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("agent:commit", handler);
    bus.off("agent:commit", handler);
    bus.emit("agent:commit", { agentId: "A", issueId: "A", message: "m", hash: "h" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("once() fires only once", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.once("agent:completed", handler);
    bus.emit("agent:completed", { agentId: "A", issueId: "A" });
    bus.emit("agent:completed", { agentId: "B", issueId: "B" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("handles core-specific events", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("agent:wake", handler);
    bus.emit("agent:wake", { agentId: "X", issueId: "X", message: "wake up" });
    expect(handler).toHaveBeenCalledWith({ agentId: "X", issueId: "X", message: "wake up" });
  });

  it("different event types don't cross-fire", () => {
    const bus = new TypedEventBus();
    const spawnHandler = vi.fn();
    const errorHandler = vi.fn();
    bus.on("agent:spawned", spawnHandler);
    bus.on("agent:error", errorHandler);
    bus.emit("agent:error", { agentId: "A", issueId: "A", error: "err" });
    expect(spawnHandler).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledOnce();
  });
});
