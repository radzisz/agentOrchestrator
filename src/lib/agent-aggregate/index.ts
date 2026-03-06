// ---------------------------------------------------------------------------
// Agent Aggregate — public API
// ---------------------------------------------------------------------------

export { AgentAggregate } from "./aggregate";
export { getAggregate, tryGetAggregate, createAggregate, removeAggregate, clearAggregates } from "./registry";
export type { AgentState, CurrentOperation, GitState, ServiceState, UiStatus, AwaitingReason, UiState } from "./types";
export { defaultAgentState, deriveUiStatus } from "./types";
export { deriveLegacyStatus, stateFromLegacy } from "./compat";
export { findAggregate, findAgentInfo } from "./find-agent";
