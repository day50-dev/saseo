// F-CALL-EARS: on a call, what you say reaches the librarian even where the browser has a speech
// recognizer that can't work (Chromium without Google's speech service, embedded browsers): it
// fails with a "network" error, and the server's recognizer takes over from the microphone.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const llm = await fakeLlm();
// The fake also stands in for the speech servers.
const env = testEnv(llm.url, { LIBRARIAN_STT_URL: llm.url, LIBRARIAN_TTS_URL: llm.url });
let s: TestServer;
let browser: Browser;
before(async () => {
  seed(env.LIBRARIAN_DATA, [{ id: "ears0001", name: "Ears", items: [explained("e1", "Eigenvectors", 0, 0)] }]);
  s = await startServer(env);
  // A fake microphone playing a second and a half of sound and then quiet, like someone saying a
  // sentence and pausing (it loops). (Measuring it needs an audio clock, which headless Chrome here lacks.)
  const wav = path.join(env.LIBRARIAN_DATA, "..", "said.wav");
  writeFileSync(wav, utterance());
  browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`],
  });
});
after(async () => {
  await browser?.close();
  await s?.stop();
  await llm.close();
});

/** 16-bit mono WAV: 1.5 s of a voice-like warble, then 2.5 s of silence. */
function utterance(): Buffer {
  const rate = 16000;
  const n = rate * 4;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = t < 1.5 ? Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.3 * Math.sin(2 * Math.PI * 4 * t)) : 0;
    data.writeInt16LE(Math.round(v * 20000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe("F-CALL-EARS: when the browser's recognizer can't work", () => {
  // Headless Chrome here has no audio output, so its audio clock never runs and the microphone's
  // sound is never measured: what's checked is the hand-over itself, which is what failed.
  test("the server's recognizer takes over: the microphone is opened for it, and nothing says it's broken", async () => {
    llm.reset();
    llm.on(/./, "{}");
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.grantPermissions(["microphone"], { origin: s.url });
    await ctx.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      // A recognizer that exists but fails as soon as it starts, as in Chromium without Google's service.
      w.__starts = 0;
      w.webkitSpeechRecognition = w.SpeechRecognition = class {
        onerror: ((e: { error: string }) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          (w.__starts as number)++;
          setTimeout(() => {
            this.onerror?.({ error: "network" });
            this.onend?.();
          }, 50);
        }
        stop() {}
        abort() {}
      };
      // Count asks for the microphone: the server's recognizer listens through it.
      w.__mics = 0;
      const md = navigator.mediaDevices;
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => {
        (w.__mics as number)++;
        return real(c);
      };
    });
    const p = await ctx.newPage();
    await p.goto(`${s.url}/c/ears0001`);
    await p.locator(".card-item").first().waitFor();
    await p.locator(".call-btn").click();
    await until(() => p.evaluate(() => (window as unknown as { __mics: number }).__mics > 0), 5000, "the microphone opened for the server");
    await p.waitForTimeout(1000);
    const starts = await p.evaluate(() => (window as unknown as { __starts: number }).__starts);
    assert.equal(starts, 1, "the broken recognizer isn't restarted over and over");
    assert.equal(await p.locator(".call-bar").getByText(/didn't allow|can't recognise/).count(), 0);
    await ctx.close();
  });
});
