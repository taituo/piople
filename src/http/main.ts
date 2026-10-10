import { Store } from "../core/index.ts";
import { createCoreServer } from "./server.ts";

/** PIO_DATA=./data/p.sqlite PIO_PORT=8899 [PIO_BIND=127.0.0.1] node src/http/main.ts */
let store: Store;
try {
  store = new Store(process.env.PIO_DATA ?? "./data/piople.sqlite");
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
const server = createCoreServer(store);
const bind = process.env.PIO_BIND ?? "127.0.0.1";
server.listen(Number(process.env.PIO_PORT ?? 8899), bind, () => {
  const a = server.address();
  process.stdout.write(`listening on ${bind}:${typeof a === "object" && a ? a.port : a}\n`);
});
const stop = () => server.close(() => { store.close(); process.exit(0); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
