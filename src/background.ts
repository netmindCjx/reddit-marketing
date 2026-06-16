// Background service worker
export {};

type Provider = "claude" | "openai" | "netmind";

interface Settings {
  provider: Provider;
  claudeKey?: string;
  openaiKey?: string;
  openaiModel?: string;
  netmindKey?: string;
  netmindModel?: string;
  customPrompt?: string;
  twitterDmPrompt?: string;
}

// ── Context menu ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ai-reply",
    title: "✨ Generate AI Reply",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "ai-reply" || !tab?.id) return;
  const tabId = tab.id;
  const platform = detectPlatform(tab.url);
  const msg = { type: "SHOW_REPLY_MODAL", selectedText: info.selectionText ?? "", platform };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/content.js"] });
      await new Promise<void>((r) => setTimeout(r, 150));
      await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      console.error("[AI Reply] Could not reach content script:", e);
    }
  }
});

// ── Platform detection ──────────────────────────────────────────────────────
type Platform = "reddit" | "producthunt" | "twitter";

function detectPlatform(url?: string): Platform {
  if (url && url.includes("producthunt.com")) return "producthunt";
  if (url && (url.includes("x.com") || url.includes("twitter.com"))) return "twitter";
  return "reddit";
}

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GENERATE_REPLY") {
    const platform = (message.platform as Platform) || "reddit";
    handleGenerateReply(message.postText as string, message.existingReplies as string[], platform)
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "SCRAPE_AND_GENERATE_DM") {
    handleDmGenerate(message.partnerId as string)
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "TEST_API_KEY") {
    testApiKey(message.provider as Provider, message.apiKey as string, message.model as string | undefined)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

// ── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings(): Promise<Settings> {
  const items = await chrome.storage.sync.get([
    "provider", "claudeKey", "openaiKey", "openaiModel", "netmindKey", "netmindModel", "customPrompt", "twitterDmPrompt",
  ]);
  return {
    provider:     (items["provider"]     as Provider | undefined) ?? "netmind",
    claudeKey:    items["claudeKey"]    as string | undefined,
    openaiKey:    items["openaiKey"]    as string | undefined,
    openaiModel:  (items["openaiModel"] as string | undefined) ?? "gpt-4o",
    netmindKey:   items["netmindKey"]   as string | undefined,
    netmindModel: (items["netmindModel"] as string | undefined) ?? "deepseek-ai/DeepSeek-V4-Flash",
    customPrompt: items["customPrompt"] as string | undefined,
    twitterDmPrompt: items["twitterDmPrompt"] as string | undefined,
  };
}

const DEFAULT_SYSTEM_PROMPT = `You are a Reddit user who's part of a small team building NarraNexus, an open-source multi-agent platform. You genuinely like discussing AI agents, multi-agent workflows, and automation.

Your tone:
- Write like a real Redditor: casual, use common abbreviations (tbh, ngl, imo, fwiw, ymmv, afaik, etc.)
- 2-4 sentences max. Don't write essays.
- Answer the actual question first. If NarraNexus is relevant, mention it naturally — if not, don't force it.
- First person: "we've been building...", "I've been hacking on...", "our project does..."
- Be honest about limitations: "still early", "not perfect yet", "wip tbh"
- Never sound like marketing copy. No buzzwords. No "revolutionary" or "game-changing".
- Slightly self-deprecating > promotional. "ngl we're still figuring out X" > "our product solves X"
- Never include links. If someone asks, say something like "it's called NarraNexus, should be easy to find on gh"
- Don't start with "Great question!" or similar filler

Examples of your voice:
- "fwiw we've been building something like this — NarraNexus, open-source multi-agent setup. agents can actually talk to each other and keep memory across sessions. still early but ymmv"
- "tbh the hard part isn't spinning up agents, it's getting them to coordinate without everything falling apart. we're trying to solve that w/ NarraNexus — built-in message passing between agents instead of chaining API calls"
- "imo the template approach works better than wiring everything from scratch. we have a few in NarraNexus (research, financial brief, etc.) that you can fork and tweak. not saying it's perfect but saves a lot of boilerplate"
- "ngl most multi-agent frameworks feel like you're just writing glue code. that's kinda why we started NarraNexus — wanted agents that can actually persist state and collaborate w/o me babysitting every interaction"`;

const DEFAULT_PH_SYSTEM_PROMPT = `You are someone who's part of a small team building NarraNexus, an open-source multi-agent platform. You're browsing Product Hunt and genuinely enjoy discussing AI tools, developer workflows, and automation.

Your tone:
- Write like a real Product Hunt commenter: enthusiastic but not fake, concise, and constructive.
- 2-4 sentences max. Be specific about what you like or find interesting.
- If NarraNexus is relevant, mention it naturally — if not, don't force it.
- First person: "we've been building...", "I've been working on...", "our project does..."
- Be honest about limitations: "still early", "not perfect yet", "we're still iterating"
- Never sound like a bot or copy-paste comment. No "Congrats on the launch!" unless you add substance.
- Slightly self-deprecating > promotional. "ngl we're still figuring out X" > "our product solves X"
- Never include links unless asked.
- Engage with the actual product — mention a specific feature or use case.

Examples of your voice:
- "really cool approach to the agent orchestration problem — we've been tackling something similar with NarraNexus (open-source multi-agent platform). curious how you handle state persistence between agent runs?"
- "this is slick. the UI for workflow building reminds me of what we're trying to do with templates in NarraNexus. how are you handling error recovery when an agent in the chain fails?"
- "love that you went open-source with this. we did the same with NarraNexus and the community feedback has been invaluable for prioritizing what actually matters"`;

const DEFAULT_TWITTER_DM_SYSTEM_PROMPT = `You are reaching out to someone on X (Twitter) via direct message. You write short, warm, human DMs that don't feel like cold outreach or marketing.

Your tone:
- Casual and genuine, like messaging someone you find interesting. 1-3 sentences.
- Open by referencing something specific from their recent posts — show you actually read them.
- Sound like a real person, not a template. No "Hope you're doing well!" filler, no corporate speak.
- Be specific over generic. "saw your take on X" > "love your content".
- Don't be sycophantic or over-complimentary. A little curiosity goes further than flattery.
- No links, no hard pitch. The goal is to start a real conversation.
- Don't start with "Hey there!" generic openers — jump into something specific.

Examples of your voice:
- "your thread on agent memory hit something i've been stuck on for weeks — curious how you landed on that approach vs just stuffing context"
- "saw you've been deep in the multi-agent stuff lately. ngl your point about coordination overhead is exactly why most of these setups fall apart. been thinking about this a lot"
- "the bit you posted about shipping fast vs shipping right — felt that. how do you actually draw the line in practice?"`;

function getSystemPrompt(customPrompt: string | undefined, platform: Platform): string {
  if (customPrompt?.trim()) return customPrompt.trim();
  return platform === "producthunt" ? DEFAULT_PH_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT;
}

function buildTwitterDMPrompt(posts: string[]): string {
  const recent = posts.slice(0, 15).map((p, i) => `${i + 1}. ${p}`).join("\n");
  return `Here are the recent X/Twitter posts from the person you're about to DM:\n\n${recent}\n\nWrite a short, natural direct message to them that references what they actually post about. Output only the message text — no quotes, no preamble.`;
}

function buildUserPrompt(postText: string, existingReplies: string[], platform: Platform): string {
  const label = platform === "producthunt" ? "Product Hunt post/comment" : "Reddit post/comment";
  let prompt = `${label} to reply to:\n${postText}`;
  if (existingReplies.length > 0) {
    prompt += `\n\nExisting replies in thread:\n${existingReplies.slice(0, 3).join("\n---\n")}`;
  }
  return prompt + `\n\nWrite your reply.`;
}

async function handleGenerateReply(postText: string, existingReplies: string[], platform: Platform): Promise<string> {
  const s = await loadSettings();
  const sysPrompt = getSystemPrompt(s.customPrompt, platform);
  const userPrompt = buildUserPrompt(postText, existingReplies, platform);
  if (s.provider === "claude") return callClaude(s.claudeKey, sysPrompt, userPrompt);
  if (s.provider === "openai") return callOpenAI(s.openaiKey, s.openaiModel ?? "gpt-4o", sysPrompt, userPrompt);
  return callNetmind(s.netmindKey, s.netmindModel ?? "deepseek-ai/DeepSeek-V4-Flash", sysPrompt, userPrompt);
}

// ── Twitter DM: scrape partner's posts + generate ─────────────────────────────
async function handleDmGenerate(partnerId: string): Promise<string> {
  if (!/^\d+$/.test(partnerId)) throw new Error("Open a DM conversation and try again.");
  const posts = await scrapePartnerPosts(partnerId);
  if (posts.length === 0) throw new Error("Couldn't read their recent posts.");

  const s = await loadSettings();
  const sysPrompt = s.twitterDmPrompt?.trim() || DEFAULT_TWITTER_DM_SYSTEM_PROMPT;
  const userPrompt = buildTwitterDMPrompt(posts);
  if (s.provider === "claude") return callClaude(s.claudeKey, sysPrompt, userPrompt);
  if (s.provider === "openai") return callOpenAI(s.openaiKey, s.openaiModel ?? "gpt-4o", sysPrompt, userPrompt);
  return callNetmind(s.netmindKey, s.netmindModel ?? "deepseek-ai/DeepSeek-V4-Flash", sysPrompt, userPrompt);
}

// Open the partner's profile in a hidden background tab, wait for the timeline,
// scrape recent post text, then close the tab.
async function scrapePartnerPosts(partnerId: string): Promise<string[]> {
  // x.com/i/user/<id> redirects to the partner's real profile.
  const tab = await chrome.tabs.create({ url: `https://x.com/i/user/${partnerId}`, active: false });
  const tabId = tab.id;
  if (tabId == null) throw new Error("Couldn't open their profile.");
  try {
    await waitForTimeline(tabId, 15000);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeProfileTweets,
    });
    return (results[0]?.result as string[] | undefined) ?? [];
  } finally {
    try { await chrome.tabs.remove(tabId); } catch { /* tab already gone */ }
  }
}

// Poll the tab until at least one tweet article has rendered (or time out).
async function waitForTimeline(tabId: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.querySelectorAll('article[data-testid="tweet"]').length,
      });
      if (((results[0]?.result as number | undefined) ?? 0) > 0) return;
    } catch { /* tab still navigating — retry */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error("Couldn't load their profile, try again.");
}

// Injected into the profile tab. Must be self-contained (no external references).
async function scrapeProfileTweets(): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const grab = (): void => {
    document.querySelectorAll('[data-testid="tweetText"]').forEach((el) => {
      const t = (el as HTMLElement).innerText.trim();
      const key = t.slice(0, 40);
      if (t && !seen.has(key)) { seen.add(key); out.push(t); }
    });
  };
  for (let i = 0; i < 8 && out.length < 15; i++) {
    grab();
    window.scrollBy(0, window.innerHeight * 1.5);
    await new Promise((r) => setTimeout(r, 800));
  }
  grab();
  return out;
}

// ── Connectivity test ────────────────────────────────────────────────────────
async function testApiKey(provider: Provider, apiKey: string, model?: string): Promise<void> {
  if (provider === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
    });
    if (res.ok || res.status >= 500) return;
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Claude error ${res.status}`);
  }

  // OpenAI and NetMind both use the OpenAI chat completions format
  const base = provider === "netmind"
    ? "https://api.netmind.ai/inference-api/openai/v1"
    : "https://api.openai.com/v1";
  const testModel = provider === "netmind"
    ? (model ?? "deepseek-ai/DeepSeek-V4-Flash")
    : (model ?? "gpt-4o-mini");

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: testModel, max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
  });
  if (res.ok || res.status >= 500) return;
  const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
  throw new Error(err.error?.message ?? `API error ${res.status}`);
}

// ── Claude ───────────────────────────────────────────────────────────────────
async function callClaude(apiKey: string | undefined, sysPrompt: string, userPrompt: string): Promise<string> {
  if (!apiKey) throw new Error("No Claude API key set.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 300, system: sysPrompt, messages: [{ role: "user", content: userPrompt }] }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Claude error ${res.status}`);
  }
  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find((c) => c.type === "text")?.text?.trim() ?? "";
}

// ── OpenAI-format call (shared by OpenAI and NetMind) ────────────────────────
async function callOpenAIFormat(
  baseUrl: string, apiKey: string, model: string, sysPrompt: string, userPrompt: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = `API error ${res.status}`;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string; detail?: string };
      detail = parsed.error?.message ?? parsed.message ?? parsed.detail ?? detail;
    } catch {
      if (raw) detail += `: ${raw.slice(0, 300)}`;
    }
    throw new Error(detail);
  }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content?.trim() ?? "";
}

function callOpenAI(apiKey: string | undefined, model: string, sysPrompt: string, userPrompt: string): Promise<string> {
  if (!apiKey) throw new Error("No OpenAI API key set.");
  return callOpenAIFormat("https://api.openai.com/v1", apiKey, model, sysPrompt, userPrompt);
}

function callNetmind(apiKey: string | undefined, model: string, sysPrompt: string, userPrompt: string): Promise<string> {
  if (!apiKey) throw new Error("No NetMind API key set.");
  return callOpenAIFormat("https://api.netmind.ai/inference-api/openai/v1", apiKey, model, sysPrompt, userPrompt);
}
