import { Store } from "../src/core/index.ts";
import { readBearer, fullSystem } from "../src/agents/loop.ts";
import { createGateway, gatewayUrl } from "../src/agents/pi-provider.ts";
import { openDurable, ensureConv, askConv } from "../src/agents/durable.ts";

/**
 * ask_expert across contexts: an agent in one case consults an agent
 * that lives in another case — without joining it.
 * The request carries a bounded snapshot; the answer returns as
 * assistance.answered with evidence. Neither side sees the other's history.
 *
 * Usage: node scripts/ask-expert.ts --db ./data/x.sqlite \
 *   --from case-a --by agent:scout --to case-b --expert agent:reviewer \
 *   --q "Is POOL_SIZE=0 enough to explain restart crash loops?"
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const DATA = arg("db", "./data/x.sqlite");
const FROM = arg("from", "case-a");
const BY = arg("by", "agent:scout");
const TO = arg("to", "case-b");
const EXPERT = arg("expert", "agent:reviewer");
const Q = arg("q", "question?");
const BASE = gatewayUrl();
const MODEL = process.env.PIO_MODEL ?? "deepseek-v4-flash";

const s = new Store(DATA);
const bearer = readBearer();
const now = Date.now();
const d = await openDurable(DATA + ".pi.sqlite", createGateway(BASE, bearer, [MODEL]).models, s);

// 1. Request lands in the origin case.
const reqKey = `askx:${now}`;
s.requestAssistance(FROM, BY, reqKey, EXPERT, Q, { fromCase: FROM, at: now });

// 2. Expert answers from its own case + durable history. It never sees FROM's history.
const conv = await ensureConv(d, s, TO, EXPERT, fullSystem("Olet asiantuntija: vastaat rajattuihin kysymyksiin todisteilla."), { provider: "piople", modelId: MODEL });
const ans = await askConv(d, conv, `Asiantuntijapyyntö casesta ${FROM} (et näe sen historiaa, vastaa vain annetun kysymyksen perusteella): ${Q}`, `${reqKey}:deliver`);

// 3. Answer returns to the origin case with provenance.
s.answerAssistance(FROM, EXPERT, `${reqKey}:ans`, reqKey, ans.text, [`expert:${EXPERT}@${TO}`, `model:${MODEL}`]);
console.log(`ASK_EXPERT ${FROM} -> ${EXPERT}@${TO} usage=${ans.usage.prompt_tokens}+${ans.usage.completion_tokens}`);
console.log(ans.text.slice(0, 600));
await d.close();
s.close();
