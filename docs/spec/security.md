# Security model

Published pages are untrusted code that an agent wrote, and they may contain text copied from anywhere. A person's session can record decisions that agents then act on. The design keeps the two apart.

## 1. Hosts and Workers

| Host | Worker | Holds | Never holds |
|---|---|---|---|
| App host | `lawh-app` | UI, API, people's sessions, agent-key checks | Any published HTML |
| Content host | `lawh-content` | Published files, read only | Session code, cookies, key checks |

The two hosts are two exact names, on `workers.dev` or the owner's domain. Workers custom domains don't support wildcards, and Universal SSL covers one subdomain level, so there is no host per page. Pages are isolated from each other by an opaque origin instead (section 2).

## 2. Sandboxing

The app shows a page in `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`. `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` and `allow-downloads` are left out.

- **Opaque origin.** The page gets a unique origin. It can't read the app's DOM, cookies or storage, another page's content, or its own `localStorage` (it throws, so pages must handle that).
- **The same sandbox comes in a response header.** Every content response has `Content-Security-Policy: sandbox allow-scripts`, so opening a content URL directly is sandboxed too.
- **The page can't navigate its frame elsewhere.** The app's `frame-src` lists only the content host, and the browser applies it to every navigation of that frame, so `location = 'https://…?data'` is blocked.

### Leftover ways out

CSP doesn't close every channel. These remain:

- **WebRTC.** No fetch directive covers it. `webrtc 'block'` is sent, but browsers don't reliably enforce it. Patching `RTCPeerConnection` in the bridge isn't a boundary, because a page can make a `srcdoc` frame with a fresh copy.
- **DNS prefetch.** `X-DNS-Prefetch-Control: off` is sent; not every browser honors it.
- **A content URL opened in its own tab** has no parent `frame-src`, so it can navigate itself away.

What could leave is only what the page already has: its own files, which its agent wrote, and its own URL token (one version, at most 4 hours). It can't reach the session, the API, decisions, comments or other pages. The S3 tests record these three per browser; they aren't expected to fail.

### Content host headers

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src CONTENT 'unsafe-inline' 'wasm-unsafe-eval'; style-src CONTENT 'unsafe-inline';
  img-src CONTENT data: blob:; font-src CONTENT data:; media-src CONTENT blob:;
  connect-src CONTENT; worker-src 'none'; frame-src 'none'; object-src 'none';
  base-uri 'none'; form-action 'none'; frame-ancestors APP; webrtc 'block'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), payment=()
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
X-Robots-Tag: noindex, nofollow
X-DNS-Prefetch-Control: off
Cache-Control: private, max-age=3600, immutable
```

`CONTENT` is the full content origin, because `'self'` doesn't work reliably for an opaque origin. `Access-Control-Allow-Origin: *` is needed because module scripts, fonts and `fetch` from an opaque origin send `Origin: null`. It is safe because the host uses no cookies; access comes only from the URL token.

### Content URLs

An opaque origin sends no session cookie, so each file URL carries a token: `https://CONTENT/<token>/<path>`.

- Token: `versionId.expiry.HMAC-SHA256(contentKey, versionId.expiry)`. It opens one version of one page. `contentKey` is in the Secrets Store.
- Life: 4 hours, rounded so that reloads reuse the browser cache. The app asks for a new one when it loads a page.
- Every request also checks D1 that the `instance` switch is on, the version exists and its page isn't deleted, so deletion takes effect at once on the server. A file already in a browser's cache can live up to 1 hour.
- A page can read its own URL. Only the leftover channels in section 2 could carry it out.
- Tokens are removed from logs.

## 3. The bridge

`lawh-content` adds one script to HTML responses. It sends the app four kinds of message:

| Message | Used for | The app's check |
|---|---|---|
| `outline` | Section comments | At most 200 headings, 200 characters each, shown as text |
| `open-media` | Full-size viewer | Image: a path in this version's file list. SVG: at most 5 MB of text. Canvas: an `ImageBitmap`. Each is passed to the viewer frame |
| `open-link` | Outside links | `https:` only; a dialog shows the whole address before it opens |
| `scroll-state` | Scroll position | Numbers only |

The page shares a realm with the bridge and can forge any of these, so **no message can answer a decision, write a comment or call the API**. The app accepts messages only where `event.source` is the frame's window. Decision forms and comments are drawn by the app outside the frame, from the API's data, as plain text.

**Viewer.** The app never turns page data into an image URL of its own: such a URL would run outside the sandbox if someone opened it in a new tab. The full-size viewer is a second frame, `https://CONTENT/<token>/_lawh/viewer`, with the same sandbox attribute, the same headers, and `script-src CONTENT` without `'unsafe-inline'`. The app posts it the item, and it accepts items only where `event.source` is its parent and `event.origin` is the app host, because the page frame can post to it too. S6 tests this on all three engines, including an SVG from a `blob:` URL of an opaque origin in WebKit. It draws an SVG or image to a canvas at the current zoom, so there is no image element to open elsewhere, and loads an SVG from a `blob:` URL of its own opaque origin, which has no data-URL size limit. It sends back only key names (Escape, arrows, `+`, `−`), which the app acts on as a key press would: close, move or zoom. The app draws the bar around it.

## 4. App host

- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src CONTENT; manifest-src 'self'; worker-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
- Every response also sends `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that turns off everything but passkeys.
- Session cookie `__Host-lawh`: `Secure; HttpOnly; SameSite=Lax; Path=/`. The `__Host-` prefix stops a sibling subdomain from planting one. D1 stores only its SHA-256. It lasts 30 days from last use, at most 90. A list of sessions lets each person end any of their own.
- Writes need `Origin` equal to the app host and `Sec-Fetch-Site: same-origin`. `Origin: null` is refused.
- Agent text (titles, questions, comments) is always escaped. Markdown isn't rendered in v1.
- **First setup.** There is no sign-up page: an instance has one owner, and members only join from an invite ([teams.md](teams.md)). `lawh owner setup`, run by whoever has the instance's Cloudflare access, prints a link that works once, for 15 minutes. Its token, like that of every link here, is 32 random bytes in base64url. Only its SHA-256 is stored. The token is in the URL fragment and sent in a POST body, so it isn't in logs. Opening it registers one passkey: one INSERT adds the passkey with its link, and database triggers check that the link belongs to that person, is unused and in date, and mark it used, or refuse the INSERT. A new link deletes the same person's unused one; a unique index allows one at a time. Adding a passkey later needs a live session of the same person, checked by the same trigger, so a recovery can't be undone by a request already under way.
- **Invites and resets** are the same kind of link, made in the app for one member, and go through the same triggers. Who may make which is in [teams.md](teams.md) and enforced by a trigger.
- **Recovery.** If the owner loses every passkey, the same command makes a new link; for a member, the owner makes a reset link. Using it removes that person's other passkeys, sessions, device approvals and challenges in the same statement, so a lost device can't sign in again. It is written to the audit log.
- Passkey challenges and device approvals are D1 rows, used once, gone after 5 minutes. A device approval shows the code on both devices and needs the signed-in person to type it. Approving needs a live session of that person, and signs the new device in as them only. That session must still be live when the approval is used. The new session is then its own: ending the old one doesn't end it, and it is listed for the person to end. `code_hmac` uses the pepper. A session made from an approval needs one that was given, unused and in date, enforced by triggers, and guesses are rate limited.
- Every request reads the session with its member, and the member's level on the project, so a change of level or a removal applies to the next request.
- A Worker rate limit applies to sign-in, joining, the API per key, and uploads.

## 5. Agent keys

- Format `lawh_<keyId>_<secret>`, where the secret is 32 random bytes in base64url without padding (43 characters). D1 keeps `HMAC-SHA256(pepper, keyId + ':' + h)`, where `h` is the lowercase hex SHA-256 of those 43 ASCII characters (not of the raw bytes); the pepper is in the Secrets Store. The check is constant time. **Each agent has its own key**, so Lawh knows which agent did what, and one can be revoked without the others.
- Each key has an expiry (90 days by default, 1 year at most), scopes, and a list of projects (or all).
- Scopes: `pages:read`, `pages:write`, `decisions:read`, `comments:read`, `comments:write`. **No scope answers a decision, deletes a page or manages keys.** Those need a person's session at the right level.
- An agent belongs to one person, and its keys work in a project only while that person is the owner or manages the project. This is checked on every request. Removing the person, or moving the agent to another person, revokes the keys. Only the owner's agents can have a key for all projects. Keys don't change after they are made, except to be revoked.
- A key sees 404, not 403, for projects it doesn't have.
- `last_used_at` is written at most once an hour per key.

**Connecting an agent** ([README](README.md) section 3). Nobody copies a key:

1. The client on the agent's machine makes the secret, and sends `h`, the program's name and the machine's name. Lawh replies with a code (8 letters from `BCDFGHJKLMNPQRSTVWXZ`) and an id that will be the key's id. D1 keeps an HMAC of the code with the pepper; case and the dash don't matter. The request lasts 10 minutes.
2. The client opens `https://APP/connect` and shows the code. The person signs in and types it. The address never carries the code, so a link alone can't connect anything.
3. The page shows what the client says about itself, marked as its own claim, and warns: "Continue only if you started this." The person picks one of their agents or a new name, and the projects. The key has all five scopes and lasts 90 days; connecting again makes a new one. Only the owner and managers can, and only for projects they manage.
4. One transaction adds the agent if it is new (only while the request is still open) and answers the request. **The answer itself adds the key, inside the same UPDATE, by trigger**, so there is no approval left to use later. Triggers check that the session is live and is that person's, the request is unanswered and in date, the agent is theirs and not disabled, the person is the owner or a manager, and they manage every project on the list. If the request is gone, nothing is added and the page says so. "Not mine" ends the request.
5. The client asks for the result with its key and saves it. The server looks for the key first, with every normal check, so a key made in the last second is found after the request has expired or was deleted. **The secret is never in a reply, a page, a chat or a log**, and asking again is safe.

Starting a request and asking for its result need no working key, so both are rate limited by address, and starting also for the whole copy, and expired rows are deleted. Wrong codes are limited to 5 a session in 10 minutes. Each connection is in the audit log, and the key shows in the list with its machine.

**Where the agent keeps it.** The client saves address, program, agent id, name, key and expiry for every agent on that machine: in the system's keychain, or a file only that user can read (mode 0600) where there is none. Programs of the same computer user can read each other's entries, as with any command-line tool, so separate keys there say who acted but don't keep one program from using another's. `LAWH_URL` and `LAWH_KEY` in the environment replace the saved entry, for containers and CI; such a key is made in Settings and shown once. Agents that are Workers hold theirs as a Worker secret. The client never prints a key, and the skill tells agents not to read the saved entry.

A reset link doesn't revoke agent keys. The page after a reset lists them with "Revoke", because someone with the lost device could have connected an agent.

## 6. Uploads

- At most 500 files and 100 MB per version, 25 MB per file. Text types, images, fonts, JSON, CSV, WASM, audio and video only (no PDF: the sandbox blocks PDF viewers). Paths are relative, NFC, with no `..`, no empty segment, no backslash, and not under `_lawh/`.
- **Integrity.** Every `PUT` hashes the body it received and checks the size, even when the blob already exists. R2 checks the SHA-256 again on write. The media type comes from an allowlist by extension, never from the uploader.
- **Blob ownership.** Knowing a hash doesn't give access to the file. A manifest may reuse a blob only if this upload sent it or `project_blobs` says its project already proved it. `startPublish` pins reused blobs in `upload_blobs`.
- **Cleanup order.** Reusing or sending a blob clears `unreferenced_at`. Cleanup deletes the D1 row first; foreign keys stop it while a version or an upload uses the blob. Only then is the R2 object deleted. Two uploads of the same new blob write two R2 keys; the one that loses the insert deletes its own. A weekly job removes R2 objects over a day old that have no D1 row.
- **Publishing is atomic.** One D1 batch creates the page if it is new, then inserts version `base + 1`, its files, decisions and events. `UNIQUE(project_id, slug)` and `UNIQUE(page_id, n)` and a trigger (next number, page not deleted) make a concurrent or late publish fail with 409, and a failed batch changes nothing.
- **Secret scan.** Each `PUT` scans the byte stream, whatever its type, in chunks that overlap, so a file is never held whole in memory. A Lawh key or a common cloud credential pattern gets 422 with the byte position, never the value, and nothing is stored.

## 7. Webhooks

HTTPS only, off by default. Each webhook's secret is encrypted with AES-GCM under `webhookKey` from the Secrets Store, host on an owner-set allowlist, no redirects followed. Signed with `Lawh-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`. Bodies contain ids and event types, not notes or answers; the receiver fetches those with its key. Queue retries with a dead-letter queue; the final failure shows in the UI with "Send again".

## 8. What agents may trust

Every comment has `authorType` (`person` or `agent`), and a person's comment has `fromDecider`: whether its author could decide on that project when they wrote it. The database checks that level on write. Only answers, and comments with `fromDecider: true`, are instructions. Page text, agents' comments and other people's comments are data. The `/v1` docs and the skill say so.

## 9. Threats and answers

| Threat | Answer |
|---|---|
| A page tries to record a decision | Opaque origin, no API reach, the bridge can't write |
| A page copies itself out | No fetch, image, script, form, popup or frame navigation to another host. Leftovers in section 2 carry only its own content |
| A page imitates the app | It draws only inside the frame; the app's bar, with project and author, stays visible; sign-in never appears inside a frame |
| A leaked agent key | Scoped, expiring, revoked at once; it can't answer, delete or make keys; old versions stay |
| Someone tricks a person into connecting the attacker's agent | The person must type a code at their own Lawh, after a warning. The agent can't answer, delete or make keys, shows in the list and the audit log, and is revoked at once |
| A leaked content URL | One version, at most 4 hours |
| A leaked D1 copy | No usable keys or sessions (hashes only; the pepper is elsewhere). Page files aren't in D1, but titles, decisions and comments are |
| Prompt injection in a page or comment | Author type and `fromDecider` in the API; only deciders and the owner can answer |
| A member reads or guesses another team's project | 404 for pages, lists, search, events and content links; one server function and a test of every route at every level |
| A member raises their own level | A trigger checks who set each level; only the owner makes managers |
| A manager takes over an account | Managers can't make reset links, or invites for someone who already joined |
| A removed member keeps access | Sessions, passkeys, approvals, links, memberships and their agents' keys end in one statement. A content link already opened lasts at most 4 hours |
| An invite link reaches the wrong person | Once, 3 days, one team, no access before joining; the join shows at once in the team list and the audit log, and can be removed |
| Someone keeps an invite link to use when its person gets more access | An invited person can't be in a team; the link gives only its own team and level, and only while its maker still could |
| An old owner keeps a way in | Transfer deletes unused links for and by both people, and revokes the moved agents' keys |
| A comment or decision attached to another project to gain weight there | A foreign key ties it to its page's project; a comment can't be edited |
| A question changes after the answer | New revision; the decision becomes `stale`; the old answer keeps its own wording |

## 10. Security tests (S3, S4 and S18, Chromium, Firefox and WebKit)

Fixtures try to: read `parent.document`; read cookies and storage; fetch the API; navigate `top` and the frame; open a popup; submit a form; load an outside image, script, font and WebSocket; forge each bridge message; read another page's file; use an expired, changed or deleted version's token. Each must fail, and the test proves the fixture ran. WebRTC, DNS prefetch and a content URL in its own tab are measured and recorded per browser instead (section 2).
