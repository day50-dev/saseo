# Linking a Zotero library (planned, not built)

Researchers keep their reading in [Zotero](https://www.zotero.org). Saseo should let them link
their library, bring what's in it onto a canvas, and save what they find back into it. This is the
plan for later. Nothing here is implemented yet.

## What it's for

- **Bring your reading.** Pick a collection or an item in your library. Its PDF lands on the canvas as
  pages, like any PDF, and its metadata (title, authors, year, abstract) comes with it. A linked
  web page comes as a read page.
- **Your notes come too.** Zotero notes on an item become notes beside its pages.
- **Search your library from + Add.** Next to "Search arXiv for papers", add "Search your Zotero":
  one box, the same results list, and the same **+ Add**.
- **The librarian knows your shelf.** When a card's sources include something already in your
  library, the source says so. When it looks for papers, it can look in your library first.
- **Save back.** A paper or page the librarian found gets a **Save to Zotero** button beside
  **+ Add**. It creates the item, in a collection you choose, and its PDF if Saseo has one.
  This needs write access, which you grant only if you want it.

## How Zotero lets an app in

From the [Web API v3 docs](https://www.zotero.org/support/dev/web_api/v3/basics):

- The base URL is `https://api.zotero.org`. Send `Zotero-API-Version: 3` with every request.
- **Authorizing is OAuth 1.0a.**
  1. Register Saseo at `zotero.org/oauth/apps` to get a client key and secret.
  2. Get temporary credentials from `https://www.zotero.org/oauth/request`.
  3. Send the person to `https://www.zotero.org/oauth/authorize?oauth_token=…` to approve.
  4. Exchange the approval at `https://www.zotero.org/oauth/access`.

  The result is a permanent **API key** plus their **userID**. The key lasts until they revoke it
  in Zotero, and the client secret isn't needed after that.
- **Asking for only what's needed.** The authorize page takes these parameters, which pre-fill what
  the key may do: `library_access=1`, `notes_access=1`, `write_access=0|1`, and `all_groups=none|read|write`.
  - Ask for read-only first. Ask for write access only when someone first presses Save to Zotero.
  - `GET /keys/current` reports what a key can actually do (`user.library`, `user.notes`,
    `user.write`, `groups`), so the UI can show only what's allowed.
- **Using the key:** send `Zotero-API-Key: <key>`, or `Authorization: Bearer <key>`, never in the URL.
  The basics page says OAuth 2.0 is coming. When it does, the `Bearer` form stays the same.
- **Simpler fallback, no OAuth:** someone can paste a key they made at zotero.org/settings/keys
  together with their userID. That's worth having for self-hosted servers with no registered app.

## Reading

| What | Request |
|---|---|
| Collections | `GET /users/<id>/collections`, `…/collections/top`, `…/collections/<key>/collections` |
| Items | `GET /users/<id>/items/top` (not notes or attachments), `…/items/<key>`, `…/items/<key>/children` (its notes and attachments) |
| A collection's items | `GET /users/<id>/collections/<key>/items/top` |
| Search | `q=` over titles and creators; `qmode=everything` to include full text; `tag=`, `itemType=` |
| An attachment's file | `GET /users/<id>/items/<attachmentKey>/file` (the PDF). Its `ETag` is the file's MD5. |
| Citations | `include=data,bib,citation&style=apa` (any CSL style), or `format=bibtex`, `csljson` and so on |

- **Paging:** `limit` (1–100) and `start`. `Total-Results` gives the total, and the `Link` header
  gives first, prev, next and last.
- **Group libraries:** these work the same under `/groups/<id>/…`, if the key was granted groups.
- **Full text:** reading an item's extracted full text isn't covered in the pages read so far. Saseo
  reads the PDF itself anyway, as it does for arXiv.

## Writing (Save to Zotero)

- **Get a template:** `GET /items/new?itemType=journalArticle` (or `webpage`, `preprint` and so on).
  Fill it from what Saseo knows: title, authors, date, URL, arXiv id or DOI, abstract.
- **Create the item:** `POST /users/<id>/items` with a JSON array of up to 50 items.
  - Send `Zotero-Write-Token: <32 random characters>` so a retry can't create the item twice.
  - The reply maps each item to `successful`, `unchanged` or `failed`.
  - A `412` means the token was reused or the version is stale.
- **Put it in a collection:** set its `collections: [key]`.
- **Attach the PDF:**
  1. Create a child attachment item (`parentItem`, `linkMode: "imported_file"`).
  2. Upload with `POST /users/<id>/items/<key>/file` and `If-None-Match: *`.
  3. Register the upload.

  This is the most involved part. Saving a link attachment (`linkMode: "linked_url"`) is a
  simpler first step.
- Saseo should only ever add items. Editing or deleting someone's existing items is out of scope.

## Staying in step

- Every list response carries `Last-Modified-Version`, the library's version.
- Keep that per linked library. Send `If-Modified-Since-Version: <v>` next time: a `304` means
  nothing changed.
- For changes since then: `GET /users/<id>/items?since=<v>&format=versions`, then fetch the changed
  keys (up to 50 at a time). Removals come from `GET /users/<id>/deleted?since=<v>`.
- No full offline mirror is needed. Saseo reads what someone opens, and caches it.

## Being a good client

- **Backoff:** if any response carries `Backoff: <seconds>`, wait that long before the next
  non-essential request.
- **Retries:** a `429` or `503` with `Retry-After: <seconds>` means wait that long and retry.
  Without the header, back off exponentially.
- **Concurrency:** at most 4 requests at once per library.

## Where it fits in Saseo

- **Account:** a "Zotero" row in the account settings, with Link, Unlink and what access was
  granted. Saseo stores the key and userID per person, server-side, encrypted at rest. They're
  never sent to the browser or to the model.
- **Server:** a `server/zotero.ts` client, with key handling, paging and backoff.
- **Routes:**
  - `/api/zotero/link` and `/api/zotero/callback`, for the OAuth dance
  - `/api/zotero/collections`, `/api/zotero/items?q=&collection=`, and `/api/zotero/items/:key/add`
    (to the canvas)
  - `/api/zotero/save` (back to Zotero)
- **Canvas:** an item added from Zotero becomes PDF pages (or a read page) through the same path as
  arXiv and links. Its origin records `{ kind: "zotero", itemKey, library }`, so a later
  "open in Zotero" link and the "already in your library" mark have something to go on.
- **The librarian:** when looking for papers, it can search the linked library alongside arXiv,
  with library hits listed first and marked as yours.
- **Self-hosting:** the OAuth app's client key and secret are server settings. Without them, only
  the paste-a-key fallback is offered.
- **Tests:** a fake Zotero, like the fake model in `test/helpers/fakeLlm.ts`, covers linking,
  paging, a `Backoff` header, a `412` on a reused write token, and adding an item's PDF to a canvas.
