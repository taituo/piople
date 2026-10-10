import type { Harness, Step } from "../hosts/types.ts";

/**
 * A person as a continuously running participant. No model, and no more power than anyone else: every command is an
 * ordinary op run as this actor, so Core judges it by the actor's capabilities (naming yourself `human:*` buys
 * nothing, deciding still needs `decide`). The Console is the only I/O, so tests script it.
 */
export interface Console {
  print(text: string): void;
  /** One line from the person, or null when there is no more input (stdin closed, a script ran out). */
  read(prompt: string): Promise<string | null>;
}

const HELP = `say <text> | answer <request key> | <text> | decide <decision id> <option> | claim <work id> | done <work id> <attempt> <json> | fail <work id> <attempt> <reason> | skip (or an empty line)`;

const describe = (e: { seq: number; actorId: string; type: string; data: Record<string, unknown> }) => {
  const d = e.data;
  const body = d.text ?? d.question ?? d.answer ?? (Object.keys(d).length ? JSON.stringify(d) : "");
  return `${e.seq} ${e.actorId} ${e.type}${body !== "" ? `: ${String(body)}` : ""}`;
};

/**
 * Text from other participants is printed to a person's terminal, so it must not be able to drive that terminal:
 * an ESC sequence can clear the screen, set the title or write the clipboard (OSC 52), and a right-to-left override
 * can make a line read backwards. Control characters (all but newline and tab), the C1 range and bidi controls are
 * shown as visible \\x.. / \\u.... escapes instead.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => {
    const n = c.charCodeAt(0);
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16)}`;
  });
}

export class HumanHarness implements Harness {
  private readonly io: Console;
  constructor(o: { console: Console }) {
    const c = o.console;
    this.io = { print: (t) => c.print(printable(t)), read: (prompt) => c.read(prompt) };
  }

  async step(s: Step): Promise<void> {
    const events = s.events.filter((e) => e.actorId !== s.actor);
    const p = s.pending;
    const owed: string[] = [];
    for (const a of p.assistance) owed.push(`  ask ${a.key} from ${a.from}: ${a.question}   -> answer ${a.key} | <text>`);
    for (const d of p.decisions) owed.push(`  decision ${d.id} [${d.options.join("/")}] (${d.requestedBy}): ${d.question}   -> decide ${d.id} <option>`);
    for (const w of p.work.mine) owed.push(`  work you hold ${w.id} attempt ${w.attempt}: ${JSON.stringify(w.input)}   -> done ${w.id} ${w.attempt} <json>`);
    for (const w of p.work.open) owed.push(`  work you may take ${w.id}${w.skill ? ` (skill ${w.skill})` : ""}: ${JSON.stringify(w.input)}   -> claim ${w.id}`);
    if (!events.length && !owed.length) return;
    this.io.print(`== ${s.context} ==`);
    for (const e of events) this.io.print(describe(e));
    if (owed.length) this.io.print(`Owed to you:\n${owed.join("\n")}`);
    for (;;) {
      const line = (await this.io.read("> "))?.trim();
      if (!line || line === "skip") return;
      if (line === "help") { this.io.print(HELP); continue; }
      try {
        this.io.print(await this.exec(s, line));
      } catch (e) {
        this.io.print(`refused: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async exec(s: Step, line: string): Promise<string> {
    const sp = line.indexOf(" ");
    const cmd = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    switch (cmd) {
      case "say": if (!rest) throw new Error("say what?"); await s.run("post", { text: rest }); return "posted";
      case "answer": {
        const bar = rest.indexOf("|");
        if (bar < 0) throw new Error("answer <request key> | <text>");
        await s.run("answer", { request: rest.slice(0, bar).trim(), answer: rest.slice(bar + 1).trim() });
        return "answered";
      }
      case "decide": {
        const [id, ...opt] = rest.split(/\s+/);
        if (!id || !opt.length) throw new Error("decide <decision id> <option>");
        await s.run("decide", { decision: id, answer: opt.join(" ") });
        return "decided";
      }
      case "claim": {
        const r = await s.run<{ work: { id: string; attempt: number; input: unknown } }>("work-claim", { id: rest });
        return `claimed ${r.work.id} attempt ${r.work.attempt}: ${JSON.stringify(r.work.input)}`;
      }
      case "done": {
        const m = /^(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(rest); // keep the result exactly as typed (spaces inside it matter)
        if (!m) throw new Error("done <work id> <attempt> <json>");
        await s.run("work-complete", { id: m[1], attempt: m[2], result: m[3] });
        return "completed";
      }
      case "fail": {
        const m = /^(\S+)\s+(\S+)\s*([\s\S]*)$/.exec(rest);
        if (!m) throw new Error("fail <work id> <attempt> <reason>");
        await s.run("work-fail", { id: m[1], attempt: m[2], reason: m[3] });
        return "failed";
      }
      default: throw new Error(`unknown command ${cmd} (help)`);
    }
  }
}

/** Test console: answers from a list, records everything printed; null once the list is used up. */
export function scriptedConsole(lines: string[]): Console & { out: string[] } {
  const out: string[] = [];
  let i = 0;
  return { out, print: (t) => void out.push(t), read: async (prompt) => { out.push(prompt); return i < lines.length ? lines[i++]! : null; } };
}
