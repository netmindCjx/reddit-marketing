// Popup — configure provider, API keys, and custom system prompt
export {};

type Provider = "claude" | "openai" | "netmind";

const DEFAULT_PROMPT = `You are a Reddit user who's part of a small team building NarraNexus, an open-source multi-agent platform. You genuinely like discussing AI agents, multi-agent workflows, and automation.

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

const providerSelect    = document.getElementById("provider")        as HTMLSelectElement;
const claudeSection     = document.getElementById("claude-section")  as HTMLDivElement;
const openaiSection     = document.getElementById("openai-section")  as HTMLDivElement;
const netmindSection    = document.getElementById("netmind-section") as HTMLDivElement;
const claudeKeyInput    = document.getElementById("claude-key")      as HTMLInputElement;
const openaiKeyInput    = document.getElementById("openai-key")      as HTMLInputElement;
const openaiModelSelect = document.getElementById("openai-model")    as HTMLSelectElement;
const netmindKeyInput   = document.getElementById("netmind-key")     as HTMLInputElement;
const netmindModelInput = document.getElementById("netmind-model")   as HTMLInputElement;
const promptToggle      = document.getElementById("prompt-toggle")   as HTMLSpanElement;
const promptSection     = document.getElementById("prompt-section")  as HTMLDivElement;
const promptTextarea    = document.getElementById("system-prompt")   as HTMLTextAreaElement;
const saveBtn           = document.getElementById("save-btn")        as HTMLButtonElement;
const statusEl          = document.getElementById("status")          as HTMLParagraphElement;

function setStatus(msg: string, cls: "ok" | "err" | "info" | ""): void {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

function showSection(provider: Provider): void {
  claudeSection.style.display  = provider === "claude"  ? "block" : "none";
  openaiSection.style.display  = provider === "openai"  ? "block" : "none";
  netmindSection.style.display = provider === "netmind" ? "block" : "none";
}

// Toggle prompt editor visibility
promptToggle.addEventListener("click", () => {
  const visible = promptSection.style.display !== "none";
  promptSection.style.display = visible ? "none" : "block";
  promptToggle.textContent = visible ? "▶ Custom System Prompt" : "▼ Custom System Prompt";
});

providerSelect.addEventListener("change", () => {
  showSection(providerSelect.value as Provider);
  setStatus("", "");
});

// Load saved settings
chrome.storage.sync.get(
  ["provider", "claudeKey", "openaiKey", "openaiModel", "netmindKey", "netmindModel", "customPrompt"],
  (items) => {
    const provider = (items["provider"] as Provider | undefined) ?? "netmind";
    providerSelect.value = provider;
    showSection(provider);
    if (items["claudeKey"])    claudeKeyInput.value    = items["claudeKey"]    as string;
    if (items["openaiKey"])    openaiKeyInput.value    = items["openaiKey"]    as string;
    if (items["openaiModel"])  openaiModelSelect.value = items["openaiModel"]  as string;
    if (items["netmindKey"])   netmindKeyInput.value   = items["netmindKey"]   as string;
    if (items["netmindModel"]) netmindModelInput.value = items["netmindModel"] as string;
    // Always show the prompt — saved custom or default
    promptTextarea.value = (items["customPrompt"] as string | undefined)?.trim() || DEFAULT_PROMPT;
    const hasKey =
      provider === "claude"  ? !!items["claudeKey"]  :
      provider === "openai"  ? !!items["openaiKey"]  :
      !!items["netmindKey"];
    if (hasKey) setStatus("Connected.", "ok");
  }
);

saveBtn.addEventListener("click", async () => {
  const provider = providerSelect.value as Provider;
  let apiKey = "";
  let model: string | undefined;

  if (provider === "claude") {
    apiKey = claudeKeyInput.value.trim();
    if (!apiKey.startsWith("sk-ant-")) {
      setStatus("Invalid Claude key — should start with sk-ant-", "err");
      return;
    }
  } else if (provider === "openai") {
    apiKey = openaiKeyInput.value.trim();
    model  = openaiModelSelect.value;
    if (!apiKey.startsWith("sk-")) {
      setStatus("Invalid OpenAI key — should start with sk-", "err");
      return;
    }
  } else {
    apiKey = netmindKeyInput.value.trim();
    model  = netmindModelInput.value.trim() || "deepseek-ai/DeepSeek-V4-Flash";
    if (!apiKey) {
      setStatus("Please enter a NetMind API key", "err");
      return;
    }
  }

  saveBtn.disabled = true;
  setStatus("Testing connection…", "info");

  const res = await chrome.runtime.sendMessage({
    type: "TEST_API_KEY", provider, apiKey, model,
  }) as { ok: boolean; error?: string };

  saveBtn.disabled = false;

  if (!res.ok) {
    setStatus(`Connection failed: ${res.error ?? "unknown error"}`, "err");
    return;
  }

  // Persist after successful test
  const data: Record<string, string> = { provider };
  if (provider === "claude") {
    data["claudeKey"] = apiKey;
  } else if (provider === "openai") {
    data["openaiKey"] = apiKey;
    data["openaiModel"] = model ?? "gpt-4o";
  } else {
    data["netmindKey"]   = apiKey;
    data["netmindModel"] = model ?? "deepseek-ai/DeepSeek-V4-Flash";
  }

  // Save custom prompt (empty string = use default)
  data["customPrompt"] = promptTextarea.value.trim();

  chrome.storage.sync.set(data, () => setStatus("Connected & saved!", "ok"));
});
