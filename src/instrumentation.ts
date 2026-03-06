export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Start background services after server is ready — fully async, never blocks
    setTimeout(() => {
      (async () => {
        try {
          const { loadBuiltInIntegrations, loadUserIntegrations } = await import(
            "@/integrations/registry"
          );
          await loadBuiltInIntegrations();
          await loadUserIntegrations();
          console.log("[instrumentation] Integrations loaded");
        } catch (error) {
          console.error("[instrumentation] Failed to load integrations:", error);
        }

        try {
          const { start: startDispatcher } = await import("@/services/dispatcher");
          startDispatcher();
          console.log("[instrumentation] Dispatcher started");
        } catch (error) {
          console.error("[instrumentation] Failed to start dispatcher:", error);
        }

        try {
          const { start: startMonitor } = await import("@/services/monitor");
          startMonitor();
          console.log("[instrumentation] Monitor started");
        } catch (error) {
          console.error("[instrumentation] Failed to start monitor:", error);
        }
      })().catch(console.error);
    }, 5000);
  }
}
