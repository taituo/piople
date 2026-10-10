import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Harness, PollApi, Step } from "../hosts/types.ts";

/**
 * Kubernetes launcher (plan item 9). A *launcher* is an ordinary participant: read-only in the contexts it watches,
 * declaring the skills it can launch for. It finds work that nobody has taken within `delayMs` and creates a Job for
 * it. It is the only component with cluster permissions, and it never sees an agent's credential: the Job refers to a
 * Secret by name, provisioned by the operator. The Job name is derived from the work id, so Kubernetes itself refuses
 * a duplicate (a restarted or second launcher cannot start the same work twice). Plain `kubectl`, no SDK; the cluster
 * client is the `JobRunner` seam, so tests use a fake and a pod-resident launcher could use the REST API instead.
 */
export type LaunchProfile = {
  image: string;
  /** The actor the Job's worker runs as; must be a member with write in the work's context (operator provisioning). */
  actor: string;
  coreUrl: string;
  /** Where the worker finds its token. The launcher never reads it. */
  tokenSecret: { name: string; key: string };
  env?: Record<string, string>;
  deadlineSeconds?: number;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  /** Default: node --no-warnings src/hosts/worker.ts */
  command?: string[];
  /**
   * Fail closed on egress: an init container (which holds no credential) must see this address REFUSED before the
   * worker container, which holds the token, may start. Guards against a cluster that does not enforce network
   * policy and against the moment after a pod is created before its rules are in place. Pick an address the
   * policy should block, e.g. { host: "1.1.1.1", port: 80 }.
   */
  egressGate?: { host: string; port: number; deadlineMs?: number };
};

export type JobRunner = { create(manifest: Record<string, unknown>): Promise<"created" | "exists"> };

export type LauncherOptions = {
  namespace: string;
  /** skill -> how to run it. Work with another skill is ignored. */
  profiles: Record<string, LaunchProfile>;
  /** How long work may stay untaken before a Job is started for it. */
  delayMs: number;
  runner: JobRunner;
  /** Look at Core at most this often (default 2000). */
  everyMs?: number;
  /** Jobs started per look (default 5). */
  maxPerPass?: number;
  now?: () => number;
};

export const jobName = (context: string, workId: string) => `piople-w-${createHash("sha256").update(`${context}\0${workId}`).digest("hex").slice(0, 20)}`;

export function jobManifest(namespace: string, p: LaunchProfile, w: { context: string; workId: string; skill: string }): Record<string, unknown> {
  const name = jobName(w.context, w.workId);
  const labels = { "app.kubernetes.io/name": "piople-worker", "app.kubernetes.io/managed-by": "piople-launcher", "piople.dev/work": createHash("sha256").update(`${w.context}\0${w.workId}`).digest("hex").slice(0, 32) };
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name, namespace, labels, annotations: { "piople.dev/context": w.context, "piople.dev/work-id": w.workId, "piople.dev/skill": w.skill } },
    spec: {
      backoffLimit: 3, activeDeadlineSeconds: p.deadlineSeconds ?? 900, ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never", automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
          ...(p.egressGate ? { initContainers: [{
            name: "egress-gate", image: p.image, imagePullPolicy: "IfNotPresent",
            command: ["node", "--no-warnings", "src/hosts/egress-gate.ts", p.egressGate.host, String(p.egressGate.port), String(p.egressGate.deadlineMs ?? 30_000)],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "200m", memory: "128Mi" } },
          }] } : {}),
          containers: [{
            name: "worker", image: p.image, imagePullPolicy: "IfNotPresent", command: p.command ?? ["node", "--no-warnings", "src/hosts/worker.ts"],
            env: [
              ...Object.entries(p.env ?? {}).map(([n, v]) => ({ name: n, value: v })),
              { name: "PIO_CORE_URL", value: p.coreUrl }, { name: "PIO_ACTOR", value: p.actor },
              { name: "PIO_CONTEXT", value: w.context }, { name: "PIO_WORK_ID", value: w.workId }, { name: "PIO_SKILL", value: w.skill },
              { name: "PIO_TOKEN", valueFrom: { secretKeyRef: { name: p.tokenSecret.name, key: p.tokenSecret.key } } },
            ],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: p.resources ?? { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
            volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
          }],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  };
}

/** `kubectl create -f -`: a Job that already exists is the success case of a duplicate launch, not an error. */
export function kubectlRunner(o: { kubectl?: string; kubeContext?: string } = {}): JobRunner {
  return {
    create: (manifest) => new Promise((resolve, reject) => {
      const args = [...(o.kubeContext ? ["--context", o.kubeContext] : []), "create", "-f", "-", "-o", "name"];
      const p = spawn(o.kubectl ?? "kubectl", args, { stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      p.stderr.on("data", (d: Buffer) => { if (err.length < 2000) err += d; });
      p.on("error", () => reject(new Error("kubectl could not be started")));
      p.on("close", (code) => {
        if (code === 0) return resolve("created");
        if (/AlreadyExists/.test(err)) return resolve("exists");
        reject(new Error(`kubectl create failed: ${err.trim().split("\n")[0] ?? code}`));
      });
      p.stdin.end(JSON.stringify(manifest));
    }),
  };
}

export class K8sLauncher implements Harness {
  readonly skills: string[];
  /** Jobs this launcher has started or found existing, and the errors it hit. For operators and tests. */
  readonly stats = { launched: 0, existing: 0, errors: 0 };
  private readonly o: LauncherOptions;
  private readonly firstSeen = new Map<string, number>();
  private readonly done = new Set<string>();
  private lastLook = -Infinity;

  constructor(o: LauncherOptions) {
    this.o = o;
    this.skills = Object.keys(o.profiles);
  }

  /** The launcher is driven by poll(), not by messages. */
  async step(_s: Step): Promise<void> {}

  async poll(api: PollApi): Promise<number> {
    const now = (this.o.now ?? Date.now)();
    if (now - this.lastLook < (this.o.everyMs ?? 2000)) return 0;
    this.lastLook = now;
    const work = await api.run<Array<{ id: string; contextId: string; skill: string | null; to: string | null; createdAt: number }>>("work-list", { status: "claimable" });
    const live = new Set<string>();
    let started = 0;
    for (const w of work) {
      const key = `${w.contextId}\0${w.id}`;
      live.add(key);
      const profile = w.skill !== null && w.to === null ? this.o.profiles[w.skill] : undefined;
      if (!profile || this.done.has(key)) continue;
      const seen = this.firstSeen.get(key) ?? now;
      this.firstSeen.set(key, seen);
      // Untaken for delayMs by the work's own clock or ours, whichever has run longer: a restarted launcher need not wait again.
      if (now - Math.min(seen, w.createdAt) < this.o.delayMs || started >= (this.o.maxPerPass ?? 5)) continue;
      try {
        const r = await this.o.runner.create(jobManifest(this.o.namespace, profile, { context: w.contextId, workId: w.id, skill: w.skill! }));
        this.done.add(key);
        started++;
        if (r === "created") this.stats.launched++; else this.stats.existing++;
      } catch {
        this.stats.errors++; // the cluster is unhappy: try this work again on the next look
      }
    }
    for (const k of [...this.firstSeen.keys()]) if (!live.has(k)) { this.firstSeen.delete(k); this.done.delete(k); } // taken or finished: forget
    return started;
  }
}
