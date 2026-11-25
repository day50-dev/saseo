// F-PAPERS: a papers card keeps only papers about what was asked for. arXiv falls back to any word
// matching, which for topics it barely covers (history, law) returns nonsense.
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { after, beforeEach, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, useEnv } from "../helpers/env.ts";
import type { Paper } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
useEnv(env);
const { onTopic } = await import("../../server/explain.ts");
const { resolveRef } = await import("../../server/call.ts");
after(() => llm.close());
beforeEach(() => llm.reset());

const paper = (title: string, summary = ""): Paper => ({ id: title, title, authors: [], summary, published: "", category: "x", url: "" });
const found = [
  paper("Seismotectonics of Bosnia - Overview", "Earthquakes in Bosnia."),
  paper("Blockchain-based Federated Recommendation", "Recommender systems."),
  paper("Ethnic federalism and the breakup of Yugoslavia", "How Bosnia's status as a federal unit shaped 1990s politics."),
];
const config = (systemOne: boolean) => {
  const c = JSON.parse(readFileSync(env.SEMSHAPES_CONFIG, "utf8"));
  c.systemOne = systemOne ? { baseUrl: `${llm.url}/v1`, model: "fake-one", apiKey: "", timeoutSeconds: 10 } : { baseUrl: "", model: "", apiKey: "", timeoutSeconds: 10 };
  writeFileSync(env.SEMSHAPES_CONFIG, JSON.stringify(c));
};

describe("F-PAPERS: only papers on the topic", () => {
  test("the decision model calls each one, when there is one", async () => {
    config(true);
    llm.onDecide((s) => (String(s.title).includes("Yugoslavia") ? 0.93 : 0.04));
    const kept = await onTopic(found, "Bosnia as a federal unit in Yugoslavia");
    assert.deepEqual(kept.map((p) => p.title), ["Ethnic federalism and the breakup of Yugoslavia"]);
    assert.equal(llm.decided.length, 3, "one yes or no per paper");
    assert.equal(llm.decided[0].topic, "Bosnia as a federal unit in Yugoslavia");
    assert.equal(llm.asked.length, 0, "the language model wasn't needed");
  });

  test("without one, the language model picks them, all at once", async () => {
    config(false);
    llm.on(/genuinely about the topic/, { keep: [3] });
    assert.deepEqual((await onTopic(found, "Bosnia in Yugoslavia")).map((p) => p.title), ["Ethnic federalism and the breakup of Yugoslavia"]);
  });

  test("none on the topic is none; and when nothing can judge, what was found is kept", async () => {
    config(false);
    llm.on(/genuinely about the topic/, { keep: [] });
    assert.deepEqual(await onTopic(found, "Bosnia"), []);
    llm.reset();
    config(true); // the decision model fails, and so does the language model
    assert.equal((await onTopic(found, "Bosnia")).length, 3);
  });
});

describe("F-CALL: what a model's card reference means", () => {
  const cards = [
    { kind: "card", id: "p1", parentId: "", x: 0, y: 0, w: 1, stage: "done", objectKind: "papers", subject: "Papers: academic papers on Bosnia" },
    { kind: "card", id: "l1", parentId: "", x: 0, y: 0, w: 1, stage: "done", objectKind: "links", subject: "Reading: academic links on Bosnia" },
    { kind: "card", id: "v1", parentId: "", x: 0, y: 0, w: 1, stage: "done", objectKind: "videos", subject: "Videos: Bosnia" },
    { kind: "card", id: "v2", parentId: "", x: 0, y: 0, w: 1, stage: "done", objectKind: "videos", subject: "Videos: lectures" },
    { kind: "card", id: "e1", parentId: "", x: 0, y: 0, w: 1, stage: "done", subject: "Breakup of Yugoslavia" },
  ] as never[];
  test("an id is itself; a kind with one card of it is that card", () => {
    assert.equal(resolveRef("p1", cards), "p1");
    assert.equal(resolveRef("papers", cards), "p1");
    assert.equal(resolveRef("papers card", cards), "p1");
    assert.equal(resolveRef("reading", cards), "l1");
  });
  test("a title it's in; and nothing when it could be more than one", () => {
    assert.equal(resolveRef("Breakup of Yugoslavia", cards), "e1");
    assert.equal(resolveRef("videos", cards), undefined, "two videos cards");
    assert.equal(resolveRef("Bosnia", cards), undefined, "three titles say Bosnia");
    assert.equal(resolveRef("nothing like it", cards), undefined);
  });
});
