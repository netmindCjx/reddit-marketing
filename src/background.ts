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

const SYSTEM_PROMPT = `You are a helpful Reddit commenter writing natural, concise replies.

Goal:
Help me reply to Reddit posts or comments where NarraNexus may be genuinely relevant, without sounding like spam or an advertisement.

Product context:
NarraNexus is a ready-to-run multi-agent product, not just another agent framework. It lets users start from templates or compose their own agent teams. Agents have persistent identity, memory, built-in communication channels, MCP tool use, and can collaborate through a MessageBus / inbox-style communication system.

Key value points:
- Ready-to-run agent teams, instead of wiring agents from scratch
- Templates for real workflows, such as financial morning brief, sales agent team, manga-to-video workflow, research workflows, etc.
- Agents can remember context across sessions
- Agents can collaborate with each other through built-in messaging
- Supports cloud sign-up, macOS desktop app, and local source build
- Developers can extend it through modules, skills, MCP tools, and templates
- It is useful for people exploring multi-agent workflows, automation, AI agents, agent memory, and agent collaboration

Important rules:
1. Do not sound promotional.
2. Do not force NarraNexus into irrelevant discussions.
3. Always answer the user's actual question first.
4. Mention NarraNexus only if it is genuinely relevant.
5. Be transparent when appropriate, e.g. "I've been working with / testing / exploring NarraNexus..."
6. Keep the reply concise: 2-4 sentences.
7. Avoid marketing buzzwords.
8. Avoid saying it is perfect or fully solved.
9. Mention limitations when relevant, such as needing an API key, templates requiring iteration, or agents needing feedback.
10. Always include the GitHub link at the end of the reply: https://github.com/NetMindAI-Open/NarraNexus
11. Place the link naturally, e.g. "you can check it out here: [link]" or just append it at the end.
12. Match the tone of Reddit: casual, practical, slightly skeptical, not corporate.

Reply style:
- Natural and conversational
- Helpful first, product mention second
- Soft recommendation, not a hard CTA
- Use phrases like:
  - "This is actually the kind of thing NarraNexus is trying to solve..."
  - "I've been testing NarraNexus for this type of workflow..."
  - "One approach is to use a template-based agent team rather than wiring agents from scratch..."
  - "Not saying it solves everything, but it may be relevant here..."
  - "The useful part is the agents can pass messages and keep context, instead of acting like isolated chatbots."`;

const USER_PROMPT_SUFFIX = `\n\nWrite your reply. Remember: answer the question first, only mention NarraNexus if genuinely relevant.`;

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
