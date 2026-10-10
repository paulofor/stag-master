import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";

try {
  const config = await loadConfig();
  const store = new Store(config.database);
  await store.migrate(config.adminUsername, config.adminPasswordHash);
  const server = await createApp(config, store);
  const cleanup = setInterval(() => {
    void store
      .cleanup()
      .catch(() => console.error(JSON.stringify({ event: "cleanup_unavailable" })));
  }, 60_000);
  cleanup.unref();
  server.listen(config.port, "0.0.0.0", () =>
    console.log(
      JSON.stringify({ event: "ready", service: "stag-plus-licenses", version: "0.1.0" }),
    ),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    server.close(() => {
      void store.pool.end().then(() => process.exit(0));
    });
    const timer = setTimeout(() => {
      server.closeAllConnections();
      void store.pool.end().finally(() => process.exit(1));
    }, 15_000);
    timer.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch {
  console.error(
    JSON.stringify({
      event: "startup_failed",
      message: "Confira a configuração, os arquivos de segredo e a disponibilidade do banco.",
    }),
  );
  process.exit(1);
}
