import * as store from "@/lib/store";

/**
 * Port allocation — file-based version
 *
 * 100 slots (0-99), round-robin, shared across projects.
 * Slot NN → 6 ports: 4{NN}20  4{NN}21  4{NN}22  4{NN}23  4{NN}24  4{NN}25
 *
 * All ports in 40000-49999 range to avoid Windows Hyper-V
 * reserved port ranges (often 50000-53000+).
 */

export type PortInfo = store.PortInfo;

export const getPortsForSlot = store.getPortsForSlot;
export const runtimeSlotId = store.runtimeSlotId;

export function allocate(projectName: string, issueId: string): PortInfo {
  return store.allocatePort(projectName, issueId);
}

export function free(_issueId: string): void {
  // Port slot is stored in agent/runtime PID files.
  // When those are deleted, the slot is freed automatically.
  // No separate tracking needed.
}

export function getSlot(issueId: string): PortInfo | null {
  // Search across all projects for an agent with this issueId
  const config = store.getConfig();
  for (const project of config.projects) {
    const agent = store.getAgent(project.path, issueId);
    if (agent?.portSlot !== undefined) {
      return store.getPortsForSlot(agent.portSlot);
    }
    // Also check runtimes (for runtime slot IDs like "rt:branch")
    for (const rt of store.listRuntimes(project.path)) {
      if (rt.portSlot !== undefined) {
        const rtSlotId = store.runtimeSlotId(rt.branch);
        if (rtSlotId === issueId) {
          return store.getPortsForSlot(rt.portSlot);
        }
      }
    }
  }
  return null;
}

export function listAll(): Array<{ slot: number; projectName: string | null; issueId: string | null; ports: PortInfo }> {
  const result: Array<{ slot: number; projectName: string | null; issueId: string | null; ports: PortInfo }> = [];
  const config = store.getConfig();

  for (const project of config.projects) {
    for (const agent of store.listAgents(project.path)) {
      if (agent.portSlot !== undefined) {
        result.push({
          slot: agent.portSlot,
          projectName: project.name,
          issueId: agent.issueId,
          ports: store.getPortsForSlot(agent.portSlot),
        });
      }
    }
    for (const rt of store.listRuntimes(project.path)) {
      if (rt.portSlot !== undefined) {
        result.push({
          slot: rt.portSlot,
          projectName: project.name,
          issueId: store.runtimeSlotId(rt.branch),
          ports: store.getPortsForSlot(rt.portSlot),
        });
      }
    }
  }

  return result.sort((a, b) => a.slot - b.slot);
}
