// ---------------------------------------------------------------------------
// Agent Aggregate — public API
// ---------------------------------------------------------------------------

export { AgentAggregate } from "./aggregate";
export { getAggregate, tryGetAggregate, createAggregate, removeAggregate, clearAggregates } from "./registry";
export type { AgentState, ReadonlyAgentState, CurrentOperation, GitState, ServiceState, UiStatus, AwaitingReason, UiState, TrackerStatusValue } from "./types";
export { defaultAgentState, deriveUiStatus } from "./types";
export { deriveLegacyStatus, stateFromLegacy } from "./compat";
export { findAggregate, findAgentInfo } from "./find-agent";
