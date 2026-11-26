// F-MOMENT-HEARD: when YouTube gives no captions, what was said around a stopped moment is heard
// from our own copy of the video: the stretch before and just after it, cut out as audio and
// passed to the speech recogniser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, useEnv } from "../helpers/env.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
useEnv(env);
const { heardAround } = await import("../../server/video.ts");
after(() => llm.close());

/** Seconds of 16-bit mono audio in a WAV. */
const seconds = (wav: ArrayBuffer) => (wav.byteLength - 44) / (16000 * 2);

describe("F-MOMENT-HEARD: what was said, from our own copy", () => {
  test("hears the stretch before and just after the moment, and says when it was", async () => {
    // A two-minute "lecture": a picture and a tone.
    const dir = path.join(env.LIBRARIAN_DATA, "videos");
    mkdirSync(dir, { recursive: true });
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:d=120", "-f", "lavfi", "-i", "sine=f=220:d=120", "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y", path.join(dir, "lecture0001.mp4")]);
    let got: ArrayBuffer | null = null;
    const said = await heardAround("lecture0001", 80, async (wav) => {
      got = wav;
      return "so pass at k is one minus the chance that all k attempts fail";
    });
    assert.ok(got, "the recogniser was asked");
    assert.ok(Math.abs(seconds(got!) - 55) < 0.5, `45 s before and 10 after: ${seconds(got!)} s`);
    assert.equal(said, "[0:35–1:30] so pass at k is one minus the chance that all k attempts fail");
    // Near the start there's less before it.
    await heardAround("lecture0001", 10, async (wav) => ((got = wav), "x"));
    assert.ok(Math.abs(seconds(got!) - 20) < 0.5, `from the start: ${seconds(got!)} s`);
  });

  test("nothing without a copy, and nothing when nothing is heard", async () => {
    assert.equal(await heardAround("nocopy00001", 30, async () => "words"), "");
    assert.equal(await heardAround("lecture0001", 30, async () => "  "), "");
  });
});
