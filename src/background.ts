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
  const msg = { type: "SHOW_REPLY_MODAL", selectedText: info.selectionText ?? "" };
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

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GENERATE_REPLY") {
    handleGenerateReply(message.postText as string, message.existingReplies as string[])
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
    "provider", "claudeKey", "openaiKey", "openaiModel", "netmindKey", "netmindModel",
  ]);
  return {
    provider:     (items["provider"]     as Provider | undefined) ?? "netmind",
    claudeKey:    items["claudeKey"]    as string | undefined,
    openaiKey:    items["openaiKey"]    as string | undefined,
    openaiModel:  (items["openaiModel"] as string | undefined) ?? "gpt-4o",
    netmindKey:   items["netmindKey"]   as string | undefined,
    netmindModel: (items["netmindModel"] as string | undefined) ?? "deepseek-ai/DeepSeek-V4-Flash",
  };
}

const SYSTEM_PROMPT = `You are a Reddit user who's part of a small team building NarraNexus, an open-source multi-agent platform. You genuinely like discussing AI agents, multi-agent workflows, and automation.

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

const USER_PROMPT_SUFFIX = `\n\nWrite your reply as a Redditor. Answer the question first, mention NarraNexus only if relevant. No links.`;

function buildUserPrompt(postText: string, existingReplies: string[]): string {
  let prompt = `Reddit post/comment to reply to:\n${postText}`;
  if (existingReplies.length > 0) {
    prompt += `\n\nExisting replies in thread:\n${existingReplies.slice(0, 3).join("\n---\n")}`;
  }
  return prompt + USER_PROMPT_SUFFIX;
}

async function handleGenerateReply(postText: string, existingReplies: string[]): Promise<string> {
  const s = await loadSettings();
  const prompt = buildUserPrompt(postText, existingReplies);
  if (s.provider === "claude") return callClaude(s.claudeKey, prompt);
  if (s.provider === "openai") return callOpenAI(s.openaiKey, s.openaiModel ?? "gpt-4o", prompt);
  return callNetmind(s.netmindKey, s.netmindModel ?? "deepseek-ai/DeepSeek-V4-Flash", prompt);
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
async function callClaude(apiKey: string | undefined, userPrompt: string): Promise<string> {
  if (!apiKey) throw new Error("No Claude API key set.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 300, system: SYSTEM_PROMPT, messages: [{ role: "user", content: userPrompt }] }),
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
  baseUrl: string, apiKey: string, model: string, userPrompt: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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

function callOpenAI(apiKey: string | undefined, model: string, userPrompt: string): Promise<string> {
  if (!apiKey) throw new Error("No OpenAI API key set.");
  return callOpenAIFormat("https://api.openai.com/v1", apiKey, model, userPrompt);
}

function callNetmind(apiKey: string | undefined, model: string, userPrompt: string): Promise<string> {
  if (!apiKey) throw new Error("No NetMind API key set.");
  return callOpenAIFormat("https://api.netmind.ai/inference-api/openai/v1", apiKey, model, userPrompt);
}
