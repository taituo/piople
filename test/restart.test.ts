import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { Store } from "../src/core/index.ts";
import { openDurable, ensureConv, askConv } from "../src/agents/durable.ts";

/**
 * Restart proof, offline: close everything, reopen the same files, and the agent's Pi
 * conversation is the same one, its transcript is intact, and a repeated requestId does no new work.
 */
test("a reopened case keeps the same Pi conversation and does not repeat finished work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piople-restart-"));
  const db = path.join(dir, "case.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  try {
    // phase 1
    let s = new Store(db);
    s.upsertActor({ id: "agent:scout", kind: "agent", name: "scout" });
    s.createContext({ id: "c", kind: "case", title: "t", goal: "g", createdAt: Date.now() }, "agent:scout");
    let d = await openDurable(`${db}.pi.sqlite`, models, s);
    let conv = await ensureConv(d, s, "c", "agent:scout", "You are scout.", ref);
    const convId = Number(conv.id);
    faux.setResponses([fauxAssistantMessage([fauxText("OK, remembered JUNIPER")])]);
    const r1 = await askConv(d, conv, "Remember the word JUNIPER.", "req-1");
    assert.match(r1.text, /JUNIPER/);
    await d.close();
    s.close();

    // phase 2: everything reopened from disk
    s = new Store(db);
    d = await openDurable(`${db}.pi.sqlite`, models, s);
    conv = await ensureConv(d, s, "c", "agent:scout", "You are scout.", ref);
    assert.equal(Number(conv.id), convId, "same conversation after restart");
    faux.setResponses([]); // a duplicate request must not need the model at all
    const again = await askConv(d, conv, "Remember the word JUNIPER.", "req-1");
    assert.match(again.text, /JUNIPER/, "the original reply, not new work");
    faux.setResponses([fauxAssistantMessage([fauxText("The word was JUNIPER")])]);
    const r2 = await askConv(d, conv, "What was the word?", "req-2");
    assert.match(r2.text, /JUNIPER/);
    const page = await conv.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    const kinds = (page as unknown as { items: Array<{ kind: string }> }).items.map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === "pi.user").length, 2, "one user entry per distinct request, none for the duplicate");
    assert.equal(kinds.filter((k) => k === "pi.assistant").length, 2);
    await d.close();
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
