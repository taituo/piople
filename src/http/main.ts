import { Store } from "../core/index.ts";
import { createCoreServer } from "./server.ts";

/** PIO_DATA=./data/p.sqlite PIO_PORT=8899 [PIO_BIND=127.0.0.1] node src/http/main.ts */
const store = new Store(process.env.PIO_DATA ?? "./data/piople.sqlite");
const server = createCoreServer(store);
const bind = process.env.PIO_BIND ?? "127.0.0.1";
server.listen(Number(process.env.PIO_PORT ?? 8899), bind, () => {
  const a = server.address();
  process.stdout.write(`listening on ${bind}:${typeof a === "object" && a ? a.port : a}\n`);
});
const stop = () => server.close(() => { store.close(); process.exit(0); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
