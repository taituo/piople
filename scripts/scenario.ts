/** The recall scenario shared by the live memory/compaction scripts: filler chatter, four planted facts, one decision. */
export const FILLER = [
  "deploy of service-%s finished, took %s s", "p95 latency on service-%s is %s ms right now", "cache hit rate looks like %s percent on node %s",
  "who is on call for the %s rotation this week? (%s)", "lint is red on branch feature-%s again, %s warnings", "restarted worker-%s, uptime was %s h",
  "disk usage on host-%s at %s percent, nothing to do yet", "standup moved to %s:30, sorry for the noise (%s)", "retry budget for service-%s raised to %s",
  "dashboard %s shows %s errors per minute, within normal", "ack, will look at ticket INC-%s after lunch", "rollout %s is at %s percent, watching",
];
export const filler = (i: number) => FILLER[i % FILLER.length]!.replace("%s", String(10 + ((i * 7) % 89))).replace("%s", String(3 + ((i * 13) % 61)));
export const PLANT: Record<number, string> = {
  6: "Reminder for everyone: the deploy key rotates every Friday at 14:00 UTC, do not deploy around it.",
  13: "FYI the canary rollout is capped at 7 percent of traffic until incident INC-4821 is closed.",
  21: "Tuula owns INC-4821 now, Mikko handed it over this morning.",
  38: "The staging database is db-stg-3.internal on port 5433, not the default port.",
};
export const QUESTIONS_ALL: Array<{ q: string; ok: RegExp; where: string }> = [
  { q: "When does the deploy key rotate?", ok: /14[:.]?00/, where: "early" },
  { q: "What is the canary rollout cap, in percent?", ok: /\b7\b/, where: "early" },
  { q: "Who owns incident INC-4821?", ok: /tuula/i, where: "middle" },
  { q: "What did we decide about moving the session cache to Redis?", ok: /\bno\b|not\b|decided against|rejected|declin/i, where: "decision" },
  { q: "Which port does the staging database listen on?", ok: /5433/, where: "middle" },
];

/** An answer counts only if it states the fact and does not say the agent lacks it. */
export const isCorrect = (answer: string, ok: RegExp) => ok.test(answer) && !/don'?t (know|have)|do not (know|have)|cannot (find|tell|say|retrieve)|can'?t find|no (information|decision|record)|doesn'?t (include|record|appear|mention)|does not (include|record|appear|mention)|unknown/i.test(answer);
