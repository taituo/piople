import { NativeConnection, Worker } from "@temporalio/worker";
import { HttpCore } from "../../hosts/http-core.ts";
import { createActivities } from "./activities.ts";

/**
 * The Temporal worker for the orchestrator: runs the workflows and the Activities that call Piople.
 *   TEMPORAL_ADDRESS (localhost:7233) TEMPORAL_NAMESPACE (default) TEMPORAL_TASK_QUEUE (piople)
 *   PIO_CORE_URL PIO_TOKEN PIO_ACTOR (the orchestrator's identity: needs write in the cases it drives)
 */
const need = (k: string) => process.env[k] ?? (console.error(`missing ${k}`), process.exit(2));
const actor = need("PIO_ACTOR");
const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
const worker = await Worker.create({
  connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default", taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "piople",
  workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
  activities: createActivities(new HttpCore(need("PIO_CORE_URL"), { [actor]: need("PIO_TOKEN") }), actor),
});
console.log("temporal worker running");
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => worker.shutdown());
await worker.run();
await connection.close();
