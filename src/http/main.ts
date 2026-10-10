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
// A port is a whole number from 0 (the system picks one, and says which) to 65535. `Number("")` is 0, so an exported but
// empty PIO_PORT used to mean "some random port nobody knows"; anything else that is not a port ended in a Node stack trace.
const rawPort = process.env.PIO_PORT ?? "8899";
const port = rawPort.trim() === "" ? Number.NaN : Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`error: bad-port: PIO_PORT=${JSON.stringify(rawPort)} is not a port number (0 to 65535)\n`);
  store.close();
  process.exit(1);
}
server.on("error", (e: NodeJS.ErrnoException) => {
  process.stderr.write(`error: cannot listen on ${bind}:${port}: ${e.code === "EADDRINUSE" ? "the port is already in use" : e.message}\n`);
  store.close();
  process.exit(1);
});
server.listen(port, bind, () => {
  const a = server.address();
  process.stdout.write(`listening on ${bind}:${typeof a === "object" && a ? a.port : a}\n`);
});
const stop = () => server.close(() => { store.close(); process.exit(0); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
