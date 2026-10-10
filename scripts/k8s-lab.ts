/**
 * The cluster lab (plan item 9, gate 2). Runs the same kind of task the tests run locally as a Kubernetes Job on a
 * k3s cluster, kills the pod mid-work, and checks the network policy. Everything lives in the namespace `piople-lab`,
 * which is created here and deleted at the end (pass --keep to leave it). Needs: kubectl for the target cluster,
 * podman, and passwordless `sudo k3s ctr` to put the image where the node can find it.
 *   node scripts/k8s-lab.ts [--keep] [--skip-build]
 * Not part of `npm test`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { Host } from "../src/hosts/host.ts";
import { HttpCore } from "../src/hosts/http-core.ts";
import { K8sLauncher, kubectlRunner } from "../src/adapters/k8s.ts";

const NS = "piople-lab";
const IMAGE = "localhost/piople:lab";
const PORT = 18899;
const CORE_URL = `http://core.${NS}.svc.cluster.local:8899`;
const keep = process.argv.includes("--keep");
const skipBuild = process.argv.includes("--skip-build");
const say = (m: string) => console.log(`[lab ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sh(cmd: string, args: string[], o: { input?: string; allowFail?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { input: o.input, encoding: "utf8", maxBuffer: 50_000_000 });
  if (r.status !== 0 && !o.allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  return r.stdout;
}
/** Every kubectl call this script makes is scoped to the lab namespace. */
const k = (args: string[], o?: { input?: string; allowFail?: boolean }) => sh("kubectl", ["-n", NS, ...args], o);
const kjson = (args: string[]) => JSON.parse(k([...args, "-o", "json"])) as any;
async function until<T>(what: string, f: () => T | undefined | false | Promise<T | undefined | false>, ms = 120_000, every = 500): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

let forward: ChildProcess | undefined;
let host: Host | undefined;
const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push([name, ok, detail]); say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
let failed: unknown;

try {
  sh("kubectl", ["version", "--request-timeout=10s"]);
  if (sh("kubectl", ["get", "ns", NS, "--ignore-not-found", "-o", "name"]).trim()) throw new Error(`namespace ${NS} already exists; delete it first (kubectl delete ns ${NS})`);

  if (!skipBuild) {
    say("building the image");
    sh("podman", ["build", "-q", "-t", IMAGE, "-f", "deploy/Containerfile", "."]);
    say("importing it into the node's containerd");
    sh("bash", ["-c", `set -o pipefail; podman save ${IMAGE} | sudo -n k3s ctr images import -`]);
  }

  say("creating the lab: Core, volume, service, network policies");
  const manifest = readFileSync("deploy/k8s/lab.yaml", "utf8").replaceAll("IMAGE", IMAGE);
  sh("kubectl", ["apply", "-f", "-"], { input: manifest });
  await until("core rollout", () => { try { return kjson(["get", "deploy", "core"]).status.readyReplicas === 1; } catch { return false; } }, 180_000, 1000);

  const exec = (args: string[]) => k(["exec", "deploy/core", "--", ...args]);
  const issue = (actor: string, ttlMs: number) => (JSON.parse(exec(["node", "--no-warnings", "src/cli/admin.ts", "--db", "/data/p.sqlite", "issue-token", "--actor", actor, "--ttl-ms", String(ttlMs)]).trim()) as { token: string }).token;
  const day = 86_400_000;
  const tok = { alice: issue("human:alice", day), launcher: issue("agent:launcher", day), worker: issue("agent:jobworker", day) };
  // The worker's token reaches the pods only as a Secret that the operator (this script) created; the launcher never reads it.
  k(["apply", "-f", "-"], { input: JSON.stringify({ apiVersion: "v1", kind: "Secret", metadata: { name: "jobworker-token" }, stringData: { token: tok.worker } }) });

  say(`port-forwarding the service to localhost:${PORT}`);
  forward = spawn("kubectl", ["-n", NS, "port-forward", "svc/core", `${PORT}:8899`], { stdio: "ignore" });
  const url = `http://127.0.0.1:${PORT}`;
  await until("Core through the forward", async () => { try { return (await fetch(`${url}/v1/health`)).ok; } catch { return false; } }, 30_000);

  const alice = new HttpCore(url, { "human:alice": tok.alice });
  const a = (op: string, args: Record<string, unknown> = {}) => alice.call("human:alice", op, args) as Promise<any>;
  await a("create", { id: "c1", title: "Cluster lab" });
  await a("actor", {});
  const launcherCore = new HttpCore(url, { "agent:launcher": tok.launcher });
  await launcherCore.call("agent:launcher", "actor", {});
  await new HttpCore(url, { "agent:jobworker": tok.worker }).call("agent:jobworker", "actor", {});
  await a("join", { context: "c1", actor: "agent:launcher", caps: "read" }); // sees work, cannot take it
  await a("join", { context: "c1", actor: "agent:jobworker", caps: "read,write" });

  say("starting the launcher (local process, your kubectl)");
  const launcher = new K8sLauncher({
    namespace: NS, delayMs: 2000, everyMs: 500, runner: kubectlRunner(),
    profiles: { "lab.echo": { image: IMAGE, actor: "agent:jobworker", coreUrl: CORE_URL, tokenSecret: { name: "jobworker-token", key: "token" }, deadlineSeconds: 300, egressGate: { host: "1.1.1.1", port: 80 } } },
  });
  host = new Host(launcherCore, { holder: "lab-launcher" });
  await host.add({ actor: "agent:launcher", skills: launcher.skills, harness: launcher });
  host.start();

  say("requesting work: lab.echo, 25 s of 'work'");
  await a("work-request", { context: "c1", id: "w1", skill: "lab.echo", input: JSON.stringify({ sleepMs: 25_000, text: "hello from k3s" }) });

  const pod1 = await until("a worker pod running", () => {
    const p = kjson(["get", "pods", "-l", "app.kubernetes.io/name=piople-worker"]).items.find((x: any) => x.status.phase === "Running");
    return p?.metadata.name as string | undefined;
  }, 120_000, 1000);
  say(`worker pod ${pod1} is running; waiting for its claim`);
  await until("the claim", async () => (await a("work-list", { context: "c1", status: "claimed" })).length === 1, 60_000);
  const jobs = kjson(["get", "jobs"]).items;
  check("exactly one Job exists for the work, named from the work id", jobs.length === 1 && jobs[0].metadata.annotations["piople.dev/work-id"] === "w1", jobs.map((j: any) => j.metadata.name).join(","));

  say(`killing ${pod1} mid-work`);
  k(["delete", "pod", pod1, "--force", "--grace-period=0"]);
  const pod2 = await until("a replacement pod", () => {
    const p = kjson(["get", "pods", "-l", "app.kubernetes.io/name=piople-worker"]).items.find((x: any) => x.metadata.name !== pod1 && ["Pending", "Running"].includes(x.status.phase));
    return p?.metadata.name as string | undefined;
  }, 90_000, 1000);
  say(`replacement ${pod2}; waiting for the work to finish`);
  await until("the work to be done", async () => (await a("work-list", { context: "c1", status: "done" })).length === 1, 120_000, 1000);

  const events = (await a("events", { context: "c1", limit: 200 })) as any[];
  const w = (await a("work-list", { context: "c1", status: "done" }))[0];
  check("the work finished", w.status === "done");
  check("same attempt after the kill: a restart is not a new claim", w.attempt === 1, `attempt ${w.attempt}`);
  check("exactly one completion in the log", events.filter((e) => e.type === "work.completed").length === 1);
  check("exactly one claim in the log", events.filter((e) => e.type === "work.claimed").length === 1);
  check("it was finished by the replacement pod, not the killed one", w.result?.by === pod2 && w.result?.by !== pod1, `by ${w.result?.by}`);
  check("the result carries the idempotency key for the external world", w.result?.key === "work:w1:1");
  check("the launcher started it once and never took it", launcher.stats.launched === 1 && launcher.stats.errors === 0, JSON.stringify(launcher.stats));

  check("the worker pod passed its egress gate before it got the token", (() => {
    const pods = kjson(["get", "pods", "-l", "app.kubernetes.io/name=piople-worker"]).items.filter((x: any) => x.metadata.name === pod2);
    const init = pods[0]?.status?.initContainerStatuses?.[0];
    return init?.state?.terminated?.exitCode === 0;
  })());

  say("network policy: a worker-labelled pod may reach Core and nothing else (fresh connections, after the gate)");
  // One pod, one script: waits until egress is refused (the same gate the Jobs use), then checks each target with a new connection.
  const probeScript = `
    const net=require("node:net");
    const conn=(host,port)=>new Promise(r=>{const s=net.connect({host,port});s.setTimeout(2500,()=>{s.destroy();r("BLOCKED timeout")});s.once("connect",()=>{s.destroy();r("REACHED")});s.once("error",e=>r("BLOCKED "+e.code))});
    (async()=>{
      for(let i=0;i<40;i++){ if((await conn("1.1.1.1",80)).startsWith("BLOCKED")) break; await new Promise(r=>setTimeout(r,250)); }
      let core="?"; for(let i=0;i<40;i++){ core=await conn("core.${NS}.svc.cluster.local",8899); if(core==="REACHED") break; await new Promise(r=>setTimeout(r,250)); }
      console.log("core="+core);
      console.log("internet80="+await conn("1.1.1.1",80));
      console.log("internet443="+await conn("93.184.216.34",443));
      console.log("kubeapi="+await conn("10.43.0.1",443));
      console.log("node="+await conn("10.91.1.1",6443));
      console.log("otherns="+await conn("kube-dns.kube-system.svc.cluster.local",9153));
    })();`;
  const r = spawnSync("kubectl", ["-n", NS, "run", "np-check", "--rm", "-i", "--restart=Never", "--quiet", `--image=${IMAGE}`, "--image-pull-policy=IfNotPresent", "--labels=app.kubernetes.io/name=piople-worker",
    `--overrides=${JSON.stringify({ spec: { automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: 10001 }, containers: [{ name: "np-check", image: IMAGE, imagePullPolicy: "IfNotPresent", command: ["node", "-e", probeScript] }] } })}`], { encoding: "utf8", timeout: 120_000 });
  const got = Object.fromEntries(`${r.stdout}`.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string]));
  check("a worker can reach Core", got.core === "REACHED", got.core);
  for (const [name, label] of [["internet80", "the internet (80)"], ["internet443", "the internet (443)"], ["kubeapi", "the Kubernetes API service"], ["node", "the node's API port"], ["otherns", "another namespace's service"]] as const)
    check(`a worker cannot reach ${label}`, (got[name] ?? "").startsWith("BLOCKED"), got[name]);

  say("fail closed: in a namespace with NO policies the gate must refuse to open");
  const OPEN = "piople-lab-open";
  sh("kubectl", ["create", "ns", OPEN]);
  try {
    const g = spawnSync("kubectl", ["-n", OPEN, "run", "gate", "--restart=Never", "--quiet", `--image=${IMAGE}`, "--image-pull-policy=IfNotPresent",
      `--overrides=${JSON.stringify({ spec: { automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: 10001 }, containers: [{ name: "gate", image: IMAGE, imagePullPolicy: "IfNotPresent", command: ["node", "--no-warnings", "src/hosts/egress-gate.ts", "1.1.1.1", "80", "6000"] }] } })}`], { encoding: "utf8" });
    void g;
    const phase = await until("the gate pod to finish", () => { const p = JSON.parse(sh("kubectl", ["-n", OPEN, "get", "pod", "gate", "-o", "json"])).status; return ["Succeeded", "Failed"].includes(p.phase) ? p.phase : undefined; }, 90_000, 1000);
    check("the gate refuses to open where egress is not restricted", phase === "Failed", phase);
  } finally {
    sh("kubectl", ["delete", "ns", OPEN, "--wait=false"], { allowFail: true });
  }
} catch (e) {
  failed = e;
  console.error(`lab failed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await host?.close().catch(() => {});
  forward?.kill();
  if (keep) say(`left ${NS} in place (kubectl delete ns ${NS} to remove it)`);
  else {
    say(`deleting namespace ${NS}`);
    sh("kubectl", ["delete", "ns", NS, "--wait=true", "--timeout=120s"], { allowFail: true });
  }
}
const bad = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? " (the lab itself failed)" : ""}`);
process.exit(failed || bad.length ? 1 : 0);
