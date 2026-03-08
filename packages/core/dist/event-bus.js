// ---------------------------------------------------------------------------
// Typed Event Bus — singleton for agent lifecycle events
// ---------------------------------------------------------------------------
var _a;
import { EventEmitter } from "events";
export class TypedEventBus {
    constructor() {
        this.emitter = new EventEmitter();
        this.emitter.setMaxListeners(50);
    }
    on(event, listener) {
        this.emitter.on(event, listener);
    }
    off(event, listener) {
        this.emitter.off(event, listener);
    }
    emit(event, data) {
        this.emitter.emit(event, data);
    }
    once(event, listener) {
        this.emitter.once(event, listener);
    }
}
const globalForEventBus = globalThis;
export const eventBus = (_a = globalForEventBus.eventBus) !== null && _a !== void 0 ? _a : new TypedEventBus();
globalForEventBus.eventBus = eventBus;
//# sourceMappingURL=event-bus.js.map