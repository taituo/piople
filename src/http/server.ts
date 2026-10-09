import { Store } from "../core/index.ts";
import { createApp } from "./app.ts";

const PORT = Number(process.env.PIO_PORT ?? 8899);
const DATA = process.env.PIO_DATA ?? "./data/piople.sqlite";

const store = new Store(DATA);
const server = createApp(store, {
  authMode: process.env.PIO_AUTH_MODE === "proxy" ? "proxy" : "dev",
  ...(process.env.PIO_TEST_USER ? { testUser: process.env.PIO_TEST_USER } : {}), // dev/synthetic only
});
server.listen(PORT, () => console.log(`piople V0 listening on :${PORT} data=${DATA}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
