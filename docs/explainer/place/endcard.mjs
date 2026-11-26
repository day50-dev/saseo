// The end card for "A place to think" (the other title cards are titles.mjs; not re-rendered here).
import { chromium } from "playwright-core";
const DIR = new URL(".", import.meta.url).pathname;
const html = `<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1920px; height: 1080px; font-family: "Inter", "Segoe UI", system-ui, sans-serif; background: #f6f4ee; color: #1b2a3f;
    background-image: radial-gradient(#d9d4c7 1.5px, transparent 1.5px); background-size: 36px 36px; overflow: hidden; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; text-align: center; }
  h1 { font-size: 110px; font-weight: 700; letter-spacing: -0.02em; }
  h2 { font-size: 58px; font-weight: 500; color: #3a4a63; }
  @font-face { font-family: "Saseo KR"; src: url(data:font/woff2;base64,d09GMgABAAAAAAWQABIAAAAACqwAAAUxAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGYFqGx4cgmAGYD9TVEFULgBcEQgKhRCEFgsYAAE2AiQDKgQgBYRqByAMBxckGBgb4AjIxKd/N/tzc9OgVU9FHWpKlXZ3sxDEh8KK6lOTyhP9W3esfj/Vb06ouEQCGZtYlbngZf8LKuQCkjAVsq4egFV1hawRqiZjiwN0H9HYs/pTIHbNBSX0738HFhJVa7cG9brlbhtyjW7RilyT4DCi3iQ4zKi3Cg4B9TbB40AuOB+KTsxEMjYg4U0x+QgEhTmWYBko/cDN4WQDMIWfzUU6rUA2BmFgzAaIbxsobXX3Td8rAFizzrDYrDN4zHrR6XbaHS46csQhDgHunBRsIBmfL6ygobgCzyWM9NRP/ZRL/dR/XT+iQLr6BnnIwyA2z4A+Ed2NmjWT7CArMz7I6gSbB7k2i92JdJtTJ9L8kruO8ctH8iPyOgsJHsIauDCGBAQh6NtYKQjywRUNPwmVKl3xCDOD85ll4Ad2GdyCfd4vg9wXn3VlgWxnwvbmWfZlgiDEGM72dtYt2yDfeix9lezLgoXZwYwZXWcPsgDFRN1gFAw20UJ0N+b8Wxs0jUU8P9Ckau5DI/iP46jLt03MYrcRflE+kXyvMonM30rzDMymkc15cWCWGk0eknjQY5Yh+yz9XtMBFMKKiM8mFu3fCYAUDDjwwbJgIVj86LmP4xrHyudbff+fuX7mkTMPNozXn8j2sk2UoO7zIVBBQZwFiV40XgLINwOVH6hSMFuwb4H7zSyllAYFsSzLBgQc0krl8ufDkmDOYgwQRcmyQIOBM65UYN3MzMyMauTL+flf50kKfX7259lZteaLubm5ObJSwci1CsiXKiDXLgyrW3P7yLfzaTJq92ZnqzTf2FadgpMvVNY9J9x4dxxYNzOjGTSke/ptTPjLc3ID1z/OyXVLj/HH9sbV3bVq6uO6u4qzPtWuqrtr6uPiursQQ8M6S0vSteoubbU5c1tyS8SCpIGC08nqjF87StOTW08NFk4lRSS3LLdkTNSou9InSpCdUtN7qzcl/tGWR7FQ96DqwcmY3lu9CDileqQrdW/Laq0wWdwcpdE02JNX1Ac83PJIbbK3wTg4cLW4qXNsqnlZ6o6OpWeHtg81xDzZ9iQuS26qbv6RqXqkK3V/y+oJYbKkOVIz3OBIXtEQhAvrkpc2mDQDXFGzViv+0vLUnZ33nh3cMYirfzR7xdwXtBtVaT2NvGY6+4gmxNPsHco+rPGcn2pJH9+Y97yIz396Sv1U+Qs923vQcP5V9ave3T07egAAaIpPEM76/ntJCwNrL0spPSZqf72Ukn++6t8Db87dirh5TOGSNH5wTTTgo8Juu/Mfjqx461bE7d8VrgbnKafHoMd/36R3QUvvYh6hdzGL6F1Io3ehiER9G1sB+Oidj/wNKci/qBv0Vt3kZHB3iRQro+J9ZPLuJIgiKieDAFLupGjEFf4P6B/g9IMFeieHVDQ6AlAKZYaQ/851oxBhhhEmePYjPXChGgX2ZdPQwQ0zXPAoyV/68Vkb8uGEG0YUoA+t6EYvnPDg8iEIcGAaXRhEnnhMhBFe2CDAjRGIxH6/74QDPIqRj0IUohR5aEcxamAKATqTLCEqGpmPIhShEl07BFgVu5hogIhlEJdShqXlKEM5ClGSkARP4MkXvwb76TdBhWb0oSYzqzyti1EyJbKSKIVgHr5KMc3l0QQ9nFichd0yCx1Lt+V8CGbkF8v1dhQgC7ngsRTmqgpmCdNF210CEXobrQWoPH29EGAP/bIMDMEJL9zQQTKUQZtcyrdRrrV56i3i2/wSuxskCOTSHWXdt/jKb2tXrbNCMB7UhUmUbWdRFw6jDGU=) format("woff2"); }
  .ko { font-family: "Saseo KR"; font-size: 56px; font-weight: 400; color: #6b7a90; margin-left: 18px; vertical-align: middle; }
  p { font-size: 46px; color: #2b5797; font-weight: 600; margin-top: 18px; }
</style>
<div class="center"><h1>Saseo <span class="ko">사서</span></h1><h2>A place to think.</h2><p>saseo.app</p></div>`;
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.setContent(html);
await p.waitForTimeout(300);
await p.screenshot({ path: `${DIR}shots/d6-end.png` });
await b.close();
console.log("d6-end");
