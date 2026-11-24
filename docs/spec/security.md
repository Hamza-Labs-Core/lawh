# Security model

Published pages are untrusted code that an agent wrote, and they may contain text copied from anywhere. The owner's session can record decisions that agents then act on. The design keeps the two apart.

## 1. Hosts and Workers

| Host | Worker | Holds | Never holds |
|---|---|---|---|
| App host | `lawh-app` | UI, API, owner session, agent-key checks | Any published HTML |
| Content host | `lawh-content` | Published files, read only | Session code, cookies, key checks |

The two hosts are exact custom domains. Workers custom domains don't support wildcards, and Universal SSL covers one subdomain level, so there is no host per page. Pages are isolated from each other by an opaque origin instead (section 2).

## 2. Sandboxing

The app shows a page in `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`. `allow-same-origin`, `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals` and `allow-downloads` are left out.

- **Opaque origin.** The page gets a unique origin. It can't read the app's DOM, cookies or storage, another page's content, or its own `localStorage` (it throws, so pages must handle that).
- **The same sandbox comes in a response header.** Every content response has `Content-Security-Policy: sandbox allow-scripts`, so opening a content URL directly is sandboxed too.
- **The page can't navigate its frame elsewhere.** The app's `frame-src` lists only the content host, and the browser applies it to every navigation of that frame, so `location = 'https://…?data'` is blocked. WebRTC is not covered by fetch directives; `webrtc 'block'` is sent where supported. WebRTC remains a known leftover where a browser ignores it; the S3 tests record the behavior per browser.

### Content host headers

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src CONTENT 'unsafe-inline'; style-src CONTENT 'unsafe-inline';
  img-src CONTENT data: blob:; font-src CONTENT data:; media-src CONTENT blob:;
  connect-src CONTENT; worker-src 'none'; frame-src 'none'; object-src 'none';
  base-uri 'none'; form-action 'none'; frame-ancestors APP; webrtc 'block'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), payment=()
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
X-Robots-Tag: noindex, nofollow
Cache-Control: private, max-age=3600, immutable
```

`CONTENT` is the full content origin, because `'self'` doesn't work reliably for an opaque origin. `Access-Control-Allow-Origin: *` is needed because module scripts, fonts and `fetch` from an opaque origin send `Origin: null`. It is safe because the host uses no cookies; access comes only from the URL token.

### Content URLs

An opaque origin sends no session cookie, so each file URL carries a token: `https://CONTENT/<token>/<path>`.

- Token: `versionId.expiry.HMAC-SHA256(contentKey, versionId.expiry)`. It opens one version of one page. `contentKey` is in the Secrets Store.
- Life: 4 hours, rounded so that reloads reuse the browser cache. The app asks for a new one when it loads a page.
- Every request also checks D1 that the version exists and its page isn't deleted, so deletion takes effect at once on the server. A file already in a browser's cache can live up to 1 hour.
- A page can read its own URL, but has nowhere to send it (CSP above).
- Tokens are removed from logs.

## 3. The bridge

`lawh-content` adds one script to HTML responses. It sends the app four kinds of message:

| Message | Used for | The app's check |
|---|---|---|
| `outline` | Section comments | At most 200 headings, 200 characters each, shown as text |
| `open-media` | Full-size viewer | Image: a path in this version's file list. SVG or canvas: a blob of at most 5 MB, shown only through `<img>`, where scripts don't run |
| `open-link` | Outside links | `https:` only; a dialog shows the whole address before it opens |
| `scroll-state` | Scroll position | Numbers only |

The page shares a realm with the bridge and can forge any of these, so **no message can answer a decision, write a comment or call the API**. The app accepts messages only where `event.source` is the frame's window. Decision forms and comments are drawn by the app outside the frame, from the API's data, as plain text.

## 4. App host

- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: CONTENT; connect-src 'self'; frame-src CONTENT; manifest-src 'self'; worker-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
- Session cookie `__Host-lawh`: `Secure; HttpOnly; SameSite=Lax; Path=/`. The `__Host-` prefix stops a sibling subdomain from planting one. D1 stores only its SHA-256. It lasts 30 days from last use, at most 90. A list of sessions lets the owner end any of them.
- Writes need `Origin` equal to the app host and `Sec-Fetch-Site: same-origin`. `Origin: null` is refused.
- Agent text (titles, questions, comments) is always escaped. Markdown isn't rendered in v1.
- A Worker rate limit applies to sign-in, the API per key, and uploads.

## 5. Agent keys

- Format `lawh_<keyId>_<32 random bytes>`. D1 keeps `HMAC-SHA256(pepper, secret)`; the pepper is in the Secrets Store. The check is constant time. The key is shown once.
- Each key has an expiry (90 days by default, 1 year at most), scopes, and a list of projects (or all).
- Scopes: `pages:read`, `pages:write`, `decisions:read`, `comments:read`, `comments:write`. **No scope answers a decision, deletes a page or manages keys.** Those need the owner session.
- A key sees 404, not 403, for projects it doesn't have.
- `last_used_at` is written at most once an hour per key.

**Where the agent keeps it.** A Secrets Store value can't be read back by API or dashboard; only a bound Worker can use it ([docs](https://developers.cloudflare.com/secrets-store/manage-secrets/)). An agent on a laptop can't load its key from there. See owner decision 3.

## 6. Uploads

- At most 500 files and 100 MB per version, 25 MB per file. Text types, images, fonts, JSON, CSV, PDF, WASM, audio and video only. Paths are relative, NFC, with no `..`, no empty segment, no backslash, and not under `_lawh/`.
- **Integrity.** R2 checks the SHA-256 during the write, and the server checks the size. The media type comes from an allowlist by extension, never from the uploader.
- **Blob ownership.** Knowing a hash doesn't give access to the file. A manifest may reuse a blob only if this upload sent it or an earlier version *in the same project* already uses it.
- **Publishing is atomic.** One D1 batch inserts version `base + 1`, its files, decisions and events. `UNIQUE(page_id, n)` makes a concurrent publish fail with 409, and a failed batch changes nothing.
- A scan for key-shaped strings refuses a publish that contains a Lawh key or a common cloud credential pattern (422, naming the file and line, never the value).

## 7. Webhooks

HTTPS only, off by default, host on an owner-set allowlist, no redirects followed. Signed with `Lawh-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`. Bodies contain ids and event types, not notes or answers; the receiver fetches those with its key. Queue retries with a dead-letter queue; the final failure shows in the UI with "Send again".

## 8. What agents may trust

Every comment has `authorType` (`owner` or `agent`). Only the owner's answers and comments are instructions from the owner. Page text and other agents' comments are data. `/v1` docs and the MCP tool descriptions say so.

## 9. Threats and answers

| Threat | Answer |
|---|---|
| A page tries to record a decision | Opaque origin, no API reach, the bridge can't write |
| A page copies itself out | No network beyond its own files; no frame navigation, popups or forms |
| A page imitates the app | It draws only inside the frame; the app's bar, with project and author, stays visible; sign-in never appears inside a frame |
| A leaked agent key | Scoped, expiring, revoked at once; it can't answer, delete or make keys; old versions stay |
| A leaked content URL | One version, at most 4 hours |
| A leaked D1 copy | No usable keys or sessions (hashes only; the pepper is elsewhere). Page files aren't in D1, but titles, decisions and comments are |
| Prompt injection in a page or comment | Author type in the API; only the owner can answer |
| A question changes after the answer | New revision; the decision becomes `stale`; the old answer keeps its own wording |

## 10. Security tests (S3 and S4, Chromium, Firefox and WebKit)

Fixtures try to: read `parent.document`; read cookies and storage; fetch the API; navigate `top` and themselves; open a popup; submit a form; load an outside image, script, font and WebSocket; open WebRTC; forge each bridge message; read another page's file; use an expired, changed or deleted version's token. Each must fail, and the test proves the fixture ran.
