export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Initialize feed buffer immediately so it captures events from the start
    import("@/lib/feed-buffer").then(({ initFeedBuffer }) => initFeedBuffer()).catch(console.error);

    // Start background services after server is ready — fully async, never blocks
    setTimeout(() => {
      (async () => {
        try {
          const { loadIMConfig } = await import("@/lib/im-config");
          loadIMConfig();
        } catch (error) {
          console.error("[instrumentation] Failed to load IM config:", error);
        }

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
