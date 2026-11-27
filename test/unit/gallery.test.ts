import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { imageSize, imagesInHtml } from "../../server/gallery.ts";

describe("a picture's size, from its first bytes", () => {
  test("PNG, GIF and JPEG", () => {
    const png = Buffer.alloc(32);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    assert.deepEqual(imageSize(png), { w: 640, h: 480 });
    const gif = Buffer.alloc(32);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(300, 6);
    gif.writeUInt16LE(200, 8);
    assert.deepEqual(imageSize(gif), { w: 300, h: 200 });
    // SOI, an APP0 segment, then a baseline frame header: height before width.
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(imageSize(jpg), { w: 800, h: 600 });
    assert.equal(imageSize(Buffer.from("<html>not a picture at all, just a page</html>")), null);
  });
});

describe("the pictures on a page", () => {
  test("lazy-loaded ones by their real address, each with its caption, alt text or the words around it; furniture left out", () => {
    const html = `<html><head><title>Mickey through the years</title><meta property="og:site_name" content="Disney Museum"></head><body>
      <header><img src="/logo.svg" alt="Home"></header>
      <figure><img src="data:image/svg+xml,x" data-src="/files/1928.jpg" width="480" height="380" alt=""><figcaption>Mickey in 1928</figcaption></figure>
      <div><img src="/files/sheet-small.jpg" srcset="/files/sheet-400.jpg 400w, /files/sheet-1200.jpg 1200w" alt="A 1940 model sheet"></div>
      <p>The rounder Mickey of the fifties. <img src="/files/1950.jpg"></p>
      <img src="/files/spacer.gif" width="1" height="1">
    </body></html>`;
    const f = imagesInHtml(html, "https://museum.example/blog/mickey");
    assert.deepEqual(
      f.map((x) => [x.url, x.said]),
      [
        ["https://museum.example/files/1928.jpg", "Mickey in 1928"],
        ["https://museum.example/files/sheet-1200.jpg", "A 1940 model sheet"],
        ["https://museum.example/files/1950.jpg", "(near: The rounder Mickey of the fifties.)"],
      ],
    );
    assert.equal(f[0].site, "Disney Museum");
    assert.equal(f[0].pageTitle, "Mickey through the years");
  });
});
