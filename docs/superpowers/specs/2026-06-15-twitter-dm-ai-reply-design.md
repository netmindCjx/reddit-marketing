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
is scraping the partner's recent posts.

## Feasibility — confirmed via in-browser tests

All three unknowns were validated by running probe snippets in the user's
logged-in browser:

1. **Scraping posts from rendered DOM works.** `article[data-testid="tweet"]` +
   `[data-testid="tweetText"]` returns clean post text. No anti-scraping endpoint
   is touched. Caveat: X uses virtualized scrolling — only ~3 posts are in the DOM
   per viewport, so the scraper must auto-scroll to accumulate more.
2. **Partner handle is recoverable from the DM page.** Anchor hrefs matching
   `^/[A-Za-z0-9_]{1,15}$` include the partner (`/AgentArena42`) alongside a fixed
   set of nav routes (`/home`, `/explore`, `/notifications`, ...) that are filtered
   out by a whitelist.
3. **Composer located.** `textarea[data-testid="dm-composer-textarea"]`. It is a
   real `<textarea>`, so the existing `insertTextIntoEditor()` textarea path
   (`.value` + `input`/`change` events) applies directly.

Server-side fetching is impossible (login wall, HTTP 402) — scraping must run in
the user's logged-in browser session. The design relies on that session.

## Non-goals (YAGNI)

- Per-message prompt input box. The prompt is fixed and configured in the popup,
  same mechanism as the existing `customPrompt`.
- List-based or multi-account scraping. Target is the single DM partner only.
- Replaying Twitter's internal GraphQL endpoints (method B). DOM scraping
  (method A) is sufficient and avoids the fragile `x-client-transaction-id`
  anti-scraping header.

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

### 3. Content script — DM composer button
- Extend `isReplyEditor()` (or add a Twitter-specific check) to recognize
  `textarea[data-testid="dm-composer-textarea"]`.
- Reuse the existing floating-button show/hide/position machinery. Button label
  for DMs: "✨ AI DM".
- On click (Twitter platform): parse the partner handle from the DM page, then run
  the generate flow and insert the result via `insertTextIntoEditor()`.

#### Handle extraction (content script)
```
function getDmPartnerHandle(): string | null
```
- Collect `a[href]` values matching `^/[A-Za-z0-9_]{1,15}$`.
- Exclude a nav whitelist: `home`, `explore`, `notifications`, `messages`,
  `i`, `settings`, `compose`, plus the logged-in user's own handle if detectable.
- Prefer a handle found within the conversation header region; fall back to the
  first non-whitelisted handle.
- Return `null` if none found (UI shows an error: "couldn't detect who you're
  messaging").

### 4. Background — scrape orchestration (new)
New message type `SCRAPE_AND_GENERATE_DM` (or extend `GENERATE_REPLY` with a
`twitterHandle` field). Flow in background:

1. `tab = chrome.tabs.create({ url: 'https://x.com/<handle>', active: false })`
2. Wait for load (listen for `tabs.onUpdated` status `complete`, plus a short
   settle delay for the SPA timeline to render).
3. `chrome.scripting.executeScript({ target: { tabId }, func: scrapeProfile })`
   where `scrapeProfile`:
   - Scrolls the window N times (e.g. 5), waiting ~600ms between scrolls.
   - After each scroll, collects `[data-testid="tweetText"]` innerText, dedup by
     text prefix.
   - Stops early once it has collected `>= targetCount` (e.g. 15) posts.
   - Returns `string[]` of post texts.
4. `chrome.tabs.remove(tabId)` regardless of outcome (cleanup in `finally`).
5. Build the prompt and call the LLM (reuse existing provider call functions).

Timeouts and errors: if the tab fails to load, the timeline doesn't render, or
zero posts are scraped, return a structured error so the content script can show
a readable message. Always remove the background tab.

### 5. Prompt building
```
function buildTwitterDMPrompt(posts: string[]): string
```
- Format: a short instruction + the partner's recent posts as context, asking the
  model to write a DM opener/message in the configured voice.
- System prompt from `getSystemPrompt(customPrompt, "twitter")`.

## Data flow

```
[DM page] focus composer → floating "AI DM" button
  → click → content: getDmPartnerHandle()
  → background: SCRAPE_AND_GENERATE_DM { handle }
      → open background tab x.com/<handle>
      → inject scraper (auto-scroll + collect tweetText)
      → close tab
      → buildTwitterDMPrompt(posts) + system prompt
      → call LLM (existing provider funcs)
  → reply text → content: insertTextIntoEditor(composer, text)
```

## Components & responsibilities

- `getDmPartnerHandle()` (content): DM DOM → partner handle. Pure DOM read.
- `scrapeProfile()` (injected via scripting): profile DOM → `string[]` posts.
  Self-contained, no extension APIs inside it.
- `SCRAPE_AND_GENERATE_DM` handler (background): orchestrates tab lifecycle +
  scrape + LLM call. Owns all `chrome.tabs` usage and cleanup.
- `buildTwitterDMPrompt()` (background): posts → user prompt string.
- Button wiring (content): reuses existing floating-button + insert machinery.

## Error handling

- No handle detected → "Couldn't detect who you're messaging — open the
  conversation and try again."
- Background tab load timeout → "Couldn't load their profile, try again."
- Zero posts scraped (selector changed / protected/empty account) → "Couldn't read
  their recent posts."
- Existing extension-context-invalidated handling (`isReloadError`) reused as-is.
- Background tab is always closed in a `finally` block.

## Testing

- Manual: open a real DM, click button, verify a relevant message is generated and
  inserted; verify the background tab opens hidden and closes.
- Selector resilience: the two `data-testid` selectors are the fragile points;
  document them so they can be re-probed if X changes markup.
- Handle whitelist: verify own handle and nav routes are excluded.

## Open risks

- X markup / `data-testid` changes break selectors (known, accepted; easy to
  re-probe and patch).
- Background-tab scraping is visible in the tab list for ~1-2s and adds latency.
  Accepted for reliability. Method B (GraphQL replay) remains a future
  optimization, not in scope.
