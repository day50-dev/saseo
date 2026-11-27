// Zotero's sign-in is OAuth 1.0a: requests are signed with HMAC-SHA1, as the spec's own example.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { oauthSignature, safeBack } from "../../server/zotero.ts";

describe("Zotero sign-in", () => {
  test("signs a request the way the OAuth 1.0 spec's example does", () => {
    const sig = oauthSignature(
      "GET",
      "http://photos.example.net/photos?file=vacation.jpg&size=original",
      {
        oauth_consumer_key: "dpf43f3p2l4k3l03",
        oauth_token: "nnch734d00sl2jdk",
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: "1191242096",
        oauth_nonce: "kllo9940pd9333jh",
        oauth_version: "1.0",
      },
      "kd94hf93k423kf44",
      "pfkkdhi9sl3r4s00",
    );
    assert.equal(sig, "tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
  });

  test("comes back only to a page on this site", () => {
    assert.equal(safeBack("/c/abc"), "/c/abc");
    assert.equal(safeBack("//evil.example"), "/zotero");
    assert.equal(safeBack("/\\evil.example"), "/zotero");
    assert.equal(safeBack("https://evil.example"), "/zotero");
    assert.equal(safeBack(undefined), "/zotero");
  });
});
