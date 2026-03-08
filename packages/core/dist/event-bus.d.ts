import type { EventMap } from "@orchestrator/contracts";
export interface CoreEventMap extends EventMap {
    "agent:wake": {
        agentId: string;
        issueId: string;
        message: string;
    };
    "agent:stopped": {
        agentId: string;
        issueId: string;
    };
    "agent:exited": {
        agentId: string;
        issueId: string;
    };
    "agent:cleanup": {
        agentId: string;
        issueId: string;
    };
    "incoming:message": {
        issueId: string;
        source: string;
        message: string;
        userId?: string;
    };
}
export declare class TypedEventBus {
    private emitter;
    constructor();
    on<K extends keyof CoreEventMap>(event: K, listener: (data: CoreEventMap[K]) => void): void;
    off<K extends keyof CoreEventMap>(event: K, listener: (data: CoreEventMap[K]) => void): void;
    emit<K extends keyof CoreEventMap>(event: K, data: CoreEventMap[K]): void;
    once<K extends keyof CoreEventMap>(event: K, listener: (data: CoreEventMap[K]) => void): void;
}
export declare const eventBus: TypedEventBus;
//# sourceMappingURL=event-bus.d.ts.map