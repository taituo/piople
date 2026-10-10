import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/index.ts";
import { Host, LocalCore } from "../src/hosts/host.ts";
import { K8sLauncher, jobManifest, jobName, kubectlRunner, type JobRunner, type LaunchProfile } from "../src/adapters/k8s.ts";

const profile: LaunchProfile = { image: "localhost/piople:lab", actor: "agent:jobworker", coreUrl: "http://core.piople-lab.svc:8899", tokenSecret: { name: "jobworker-token", key: "token" } };

function fakeRunner(opts: { existing?: Set<string>; failFirst?: number } = {}) {
  const created: Array<Record<string, any>> = [];
  let failures = opts.failFirst ?? 0;
  const runner: JobRunner = {
    async create(m: any) {
      if (failures-- > 0) throw new Error("cluster unreachable");
      if (created.some((c) => c.metadata.name === m.metadata.name) || opts.existing?.has(m.metadata.name)) return "exists";
      created.push(m);
      return "created";
    },
  };
  return { runner, created };
}

async function world(delayMs: number, runner: JobRunner, skew = { ms: 0 }) {
  const store = new Store(":memory:");
  const core = new LocalCore(store);
  const alice = (op: string, a: Record<string, unknown> = {}) => core.call("human:alice", op, a) as Promise<any>;
  await alice("create", { id: "c1", title: "t" });
  const launcher = new K8sLauncher({ namespace: "piople-lab", profiles: { "lab.echo": profile }, delayMs, runner, everyMs: 0, now: () => Date.now() + skew.ms });
  const host = new Host(core);
  await host.add({ actor: "agent:launcher", skills: launcher.skills, harness: launcher });
  await alice("join", { context: "c1", actor: "agent:launcher", caps: "read" }); // read only: it can see work, never take it
  return { store, core, alice, launcher, host };
}

test("work untaken for the delay gets exactly one Job, named from the work id; before the delay nothing starts", async () => {
  const { runner, created } = fakeRunner();
  const skew = { ms: 0 };
  const { store, alice, launcher, host } = await world(60_000, runner, skew);
  await alice("work-request", { context: "c1", id: "w1", skill: "lab.echo", input: { n: 1 } });
  await host.settle();
  assert.equal(created.length, 0, "not yet");
  skew.ms = 61_000;
  for (let i = 0; i < 3; i++) await host.tick();
  assert.equal(created.length, 1, "launched once, however often it looks");
  assert.equal(created[0]!.metadata.name, jobName("c1", "w1"));
  assert.deepEqual([launcher.stats.launched, launcher.stats.errors], [1, 0]);
  const env = Object.fromEntries(created[0]!.spec.template.spec.containers[0].env.filter((e: any) => e.value !== undefined).map((e: any) => [e.name, e.value]));
  assert.deepEqual([env.PIO_CONTEXT, env.PIO_WORK_ID, env.PIO_ACTOR, env.PIO_SKILL], ["c1", "w1", "agent:jobworker", "lab.echo"]);
  await host.close();
  store.close();
});

test("work somebody takes in time starts nothing; another skill is ignored; work addressed to an actor is not the launcher's", async () => {
  const { runner, created } = fakeRunner();
  const skew = { ms: 0 };
  const { store, alice, host } = await world(60_000, runner, skew);
  await alice("join", { context: "c1", actor: "agent:live", caps: "read,write" });
  store.setSkills("agent:live", ["lab.echo"]);
  await alice("work-request", { context: "c1", id: "taken", skill: "lab.echo", input: 1 });
  await alice("work-request", { context: "c1", id: "other", skill: "something.else", input: 1 });
  await alice("work-request", { context: "c1", id: "addressed", to: "agent:live", input: 1 });
  await host.settle();
  store.claimWork("c1", "agent:live", "taken");
  skew.ms = 120_000;
  await host.tick();
  await host.tick();
  assert.deepEqual(created, []);
  await host.close();
  store.close();
});

test("a launcher cannot take work or post: it is read-only, and Core says so", async () => {
  const { runner } = fakeRunner();
  const { store, core, alice, host } = await world(0, runner);
  await alice("work-request", { context: "c1", id: "w1", skill: "lab.echo", input: 1 });
  await assert.rejects(core.call("agent:launcher", "work-claim", { context: "c1", id: "w1" }), /lacks write|forbidden/);
  await assert.rejects(core.call("agent:launcher", "post", { context: "c1", text: "x" }), /lacks write|forbidden/);
  await host.close();
  store.close();
});

test("a second launcher (or a restart) cannot start the same work twice: the cluster refuses the duplicate name", async () => {
  const shared = fakeRunner();
  const a = await world(0, shared.runner);
  await a.alice("work-request", { context: "c1", id: "w1", skill: "lab.echo", input: 1 });
  await a.host.tick(); await a.host.tick();
  assert.equal(shared.created.length, 1);
  // a fresh launcher with no memory of having launched it, against the same cluster
  const l2 = new K8sLauncher({ namespace: "piople-lab", profiles: { "lab.echo": profile }, delayMs: 0, runner: shared.runner, everyMs: 0 });
  const api = { actor: "agent:launcher", run: (op: string, args: any = {}) => a.core.call("agent:launcher", op, args) as any };
  await l2.poll(api);
  assert.equal(shared.created.length, 1);
  assert.equal(l2.stats.existing, 1, "found the Job already there");
  await a.host.close();
  a.store.close();
});

test("a cluster that is down is counted, not fatal, and the work is tried again on the next look", async () => {
  const { runner, created } = fakeRunner({ failFirst: 2 });
  const { store, alice, launcher, host } = await world(0, runner);
  await alice("work-request", { context: "c1", id: "w1", skill: "lab.echo", input: 1 });
  for (let i = 0; i < 4; i++) await host.tick();
  assert.equal(launcher.stats.errors, 2);
  assert.equal(created.length, 1);
  await host.close();
  store.close();
});

test("the Job asks for as little as possible: no token value, non-root, read-only root, no capabilities, no service account", () => {
  const m = jobManifest("piople-lab", { ...profile, env: { LAB: "1" } }, { context: "c1", workId: "w1", skill: "lab.echo" }) as any;
  const spec = m.spec.template.spec, c = spec.containers[0];
  assert.equal(spec.automountServiceAccountToken, false);
  assert.deepEqual([spec.securityContext.runAsNonRoot, c.securityContext.readOnlyRootFilesystem, c.securityContext.allowPrivilegeEscalation, c.securityContext.capabilities.drop], [true, true, false, ["ALL"]]);
  const token = c.env.find((e: any) => e.name === "PIO_TOKEN");
  assert.deepEqual(token, { name: "PIO_TOKEN", valueFrom: { secretKeyRef: { name: "jobworker-token", key: "token" } } }, "by reference only");
  assert.ok(m.spec.activeDeadlineSeconds > 0 && m.spec.ttlSecondsAfterFinished > 0 && m.spec.backoffLimit >= 1);
  assert.equal(m.metadata.name, jobName("c1", "w1"));
  assert.notEqual(jobName("c1", "w1"), jobName("c1", "w2"));
  assert.notEqual(jobName("c1", "w1"), jobName("c2", "w1"), "the same work id in another context is another Job");
  assert.match(jobName("c1", "w1"), /^piople-w-[0-9a-f]{20}$/);
});

test("kubectlRunner: success is created, AlreadyExists is exists, anything else is an error without the manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "piople-kubectl-"));
  const fake = (body: string) => { const p = join(dir, `k${Math.random().toString(36).slice(2)}`); writeFileSync(p, `#!/bin/sh\ncat > /dev/null\n${body}\n`); chmodSync(p, 0o755); return p; };
  const m = { kind: "Job", metadata: { name: "x" }, secretish: "TOPSECRET" };
  assert.equal(await kubectlRunner({ kubectl: fake("echo job.batch/x") }).create(m), "created");
  assert.equal(await kubectlRunner({ kubectl: fake('echo "Error from server (AlreadyExists): jobs.batch \\"x\\" already exists" >&2; exit 1') }).create(m), "exists");
  await assert.rejects(kubectlRunner({ kubectl: fake('echo "Error: forbidden" >&2; exit 1') }).create(m), (e: Error) => /forbidden/.test(e.message) && !/TOPSECRET/.test(e.message));
  await assert.rejects(kubectlRunner({ kubectl: join(dir, "missing") }).create(m), /could not be started/);
});
