# Twitter/X DM AI Reply — Design

Date: 2026-06-15
Status: Approved for planning

## Goal

Add a button next to the X (Twitter) DM composer. When clicked, it scrapes the
**DM conversation partner's** recent posts directly from the web (no Twitter
API), combines them with a user-configured prompt, calls the configured LLM, and
inserts the generated text into the DM composer.

This reuses the existing extension architecture (content script floating button →
background message → LLM call → insert into editor). The only genuinely new piece
is identifying the partner and scraping their recent posts.

## Feasibility — confirmed via in-browser tests (new XChat UI)

The target surface is the new XChat interface: `https://x.com/i/chat/<id1>-<id2>`.
All unknowns were validated by running probe snippets in the user's logged-in
browser:

1. **Partner identity comes from the URL, not the DOM.** On XChat the chat page
   DOM only exposes the *logged-in user's* own handle — the partner's handle is
   NOT present. Instead the URL path `i/chat/<id1>-<id2>` contains the two
   participant **numeric user IDs**.
2. **Own user ID is readable from the `twid` cookie** via `document.cookie`
   (format `twid=u%3D<id>`). The partner ID is the URL id that is not the own id.
   Confirmed: own `2021346015886934016`, partner `1653208312635346949`.
3. **`https://x.com/i/user/<userId>` redirects to the real profile.** Opening the
   partner ID URL landed on `https://x.com/Ishh_021`. No handle resolution needed.
4. **Profile timeline renders after load + scroll.** Header/bio render first;
   tweet nodes (`article[data-testid="tweet"]`) appear after the timeline loads
   and on scroll. A scraper must wait for the timeline and scroll to accumulate.
5. **Posts scrape cleanly from rendered DOM.** `[data-testid="tweetText"]`
   `innerText` returns post text. X virtualizes scrolling (~2-6 nodes per
   viewport), so the scraper must auto-scroll and dedup to collect more.
6. **Composer is a `<textarea>`.** Probe found
   `textarea[data-testid="dm-composer-textarea"]`. It is a real `<textarea>`, so
   the existing `insertTextIntoEditor()` textarea path (`.value` +
   `input`/`change`) applies directly. (Plan re-verifies this on the `/i/chat/`
   surface as its first step, since the prior probe may have been on `/messages/`.)

Server-side fetching is impossible (login wall, HTTP 402) — scraping must run in
the user's logged-in browser session. The design relies on that session.

## Non-goals (YAGNI)

- Per-message prompt input box. The prompt is fixed and configured in the popup,
  same mechanism as the existing `customPrompt`.
- List-based or multi-account scraping. Target is the single DM partner only.
- Replaying Twitter's internal GraphQL endpoints (method B). DOM scraping
  (method A) is sufficient and avoids the fragile `x-client-transaction-id`
  anti-scraping header.
- Resolving numeric ID → handle ourselves. `i/user/<id>` redirect does it for us.

## Architecture

### 1. Manifest changes
- `host_permissions`: add `https://x.com/*`, `https://twitter.com/*`.
- `content_scripts.matches`: add `https://x.com/*`, `https://twitter.com/*`
  (reuse the same `dist/content.js`).
- `permissions`: add `tabs` (needed to open the partner's profile in a background
  tab and close it). `scripting` is already present.

### 2. Platform extension
- Extend `Platform` type with `"twitter"` in both `content.ts` and `background.ts`.
- `detectPlatform()` returns `"twitter"` when hostname includes `x.com` or
  `twitter.com`.
- Add a Twitter-DM default system prompt (`DEFAULT_TWITTER_DM_SYSTEM_PROMPT`),
  selectable in `getSystemPrompt()`. User can override via the popup's existing
  custom-prompt field.

### 3. Content script — DM composer button + partner ID
- Recognize the DM composer `textarea[data-testid="dm-composer-textarea"]` as an
  editor that should show the floating button (label "✨ AI DM").
- On click (Twitter platform): resolve the partner user ID, send it to the
  background, then insert the returned text via `insertTextIntoEditor()`.

#### Partner ID resolution (content script)
```
function getDmPartnerId(): string | null
```
- Match `location.pathname` against `/^\/i\/chat\/(\d+)-(\d+)/` → two IDs.
- Read own ID from cookie: `document.cookie` match `twid=u%3D(\d+)` (also try a
  loose fallback for encoding variants).
- Partner ID = the URL id that is not the own id.
- Return `null` if the URL doesn't match or the own id can't be read (UI shows an
  error). Fallback when own id is unreadable is out of scope for v1 (the cookie
  was readable in testing).

### 4. Background — scrape orchestration (new)
New message `SCRAPE_AND_GENERATE_DM { partnerId }`. Flow in background:

1. `tab = chrome.tabs.create({ url: 'https://x.com/i/user/<partnerId>', active: false })`
   (the `i/user` URL redirects to the partner's real profile).
2. Wait for load: listen for `tabs.onUpdated` status `complete`, then poll via
   `chrome.scripting.executeScript` until `article[data-testid="tweet"]` count > 0
   or a timeout (e.g. 12s).
3. `chrome.scripting.executeScript({ target: { tabId }, func: scrapeProfile })`
   where `scrapeProfile`:
   - Loops up to N times (e.g. 8): grab `[data-testid="tweetText"]` innerText,
     dedup by text prefix, `window.scrollBy(0, innerHeight*1.5)`, wait ~800ms.
   - Stops early once `>= targetCount` (e.g. 15) posts collected.
   - Returns `string[]` of post texts.
4. `chrome.tabs.remove(tabId)` in a `finally` block regardless of outcome.
5. Build the prompt and call the LLM (reuse existing provider call functions).

Timeouts/errors: tab load failure, timeline never renders, or zero posts → return
a structured error so the content script shows a readable message. Always remove
the background tab.

### 5. Prompt building
```
function buildTwitterDMPrompt(posts: string[]): string
```
- Short instruction + the partner's recent posts as context, asking the model to
  write a DM message in the configured voice.
- System prompt from `getSystemPrompt(customPrompt, "twitter")`.

## Data flow

```
[XChat page] focus composer → floating "AI DM" button
  → click → content: getDmPartnerId()  (URL ids + twid cookie)
  → background: SCRAPE_AND_GENERATE_DM { partnerId }
      → open background tab x.com/i/user/<partnerId>  (→ redirects to profile)
      → wait for timeline → inject scraper (auto-scroll + collect tweetText)
      → close tab
      → buildTwitterDMPrompt(posts) + system prompt
      → call LLM (existing provider funcs)
  → reply text → content: insertTextIntoEditor(composer, text)
```

## Components & responsibilities

- `getDmPartnerId()` (content): URL + cookie → partner numeric id. Pure read.
- `scrapeProfile()` (injected via scripting): profile DOM → `string[]` posts.
  Self-contained, no extension APIs inside it.
- `SCRAPE_AND_GENERATE_DM` handler (background): orchestrates tab lifecycle +
  wait + scrape + LLM call. Owns all `chrome.tabs` usage and cleanup.
- `buildTwitterDMPrompt()` (background): posts → user prompt string.
- Button wiring (content): reuses existing floating-button + insert machinery.

## Error handling

- Not an XChat URL / can't parse ids → "Open a DM conversation and try again."
- Can't read own id from cookie → "Couldn't identify the conversation."
- Background tab load timeout / timeline never renders → "Couldn't load their
  profile, try again."
- Zero posts scraped (protected/empty account or selector changed) → "Couldn't
  read their recent posts."
- Existing extension-context-invalidated handling (`isReloadError`) reused as-is.
- Background tab always closed in a `finally` block.

## Testing

- Manual: open a real XChat DM, click button, verify a relevant message is
  generated from the partner's posts and inserted; verify the background tab opens
  hidden and closes.
- Selector resilience: fragile points are `dm-composer-textarea`, `tweetText`,
  the `twid` cookie format, and the `i/user/<id>` redirect. Documented for
  re-probing if X changes.

## Open risks

- X markup / `data-testid` / cookie format changes break the flow (known,
  accepted; easy to re-probe and patch).
- `i/user/<id>` redirect behavior could change (currently works).
- Background-tab scraping is visible in the tab list for ~1-3s and adds latency.
  Accepted for reliability. Method B (GraphQL replay) remains a future
  optimization, not in scope.
