// Popup — configure provider and API keys, with connectivity test on save
export {};

type Provider = "claude" | "openai" | "netmind";

const providerSelect    = document.getElementById("provider")       as HTMLSelectElement;
const claudeSection     = document.getElementById("claude-section") as HTMLDivElement;
const openaiSection     = document.getElementById("openai-section") as HTMLDivElement;
const netmindSection    = document.getElementById("netmind-section") as HTMLDivElement;
const claudeKeyInput    = document.getElementById("claude-key")     as HTMLInputElement;
const openaiKeyInput    = document.getElementById("openai-key")     as HTMLInputElement;
const openaiModelSelect = document.getElementById("openai-model")   as HTMLSelectElement;
const netmindKeyInput   = document.getElementById("netmind-key")    as HTMLInputElement;
const netmindModelInput = document.getElementById("netmind-model")  as HTMLInputElement;
const saveBtn           = document.getElementById("save-btn")       as HTMLButtonElement;
const statusEl          = document.getElementById("status")         as HTMLParagraphElement;

function setStatus(msg: string, cls: "ok" | "err" | "info" | ""): void {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

function showSection(provider: Provider): void {
  claudeSection.style.display  = provider === "claude"  ? "block" : "none";
  openaiSection.style.display  = provider === "openai"  ? "block" : "none";
  netmindSection.style.display = provider === "netmind" ? "block" : "none";
}

providerSelect.addEventListener("change", () => {
  showSection(providerSelect.value as Provider);
  setStatus("", "");
});

// Load saved settings
chrome.storage.sync.get(
  ["provider", "claudeKey", "openaiKey", "openaiModel", "netmindKey", "netmindModel"],
  (items) => {
    const provider = (items["provider"] as Provider | undefined) ?? "netmind";
    providerSelect.value = provider;
    showSection(provider);
    if (items["claudeKey"])    claudeKeyInput.value    = items["claudeKey"]    as string;
    if (items["openaiKey"])    openaiKeyInput.value    = items["openaiKey"]    as string;
    if (items["openaiModel"])  openaiModelSelect.value = items["openaiModel"]  as string;
    if (items["netmindKey"])   netmindKeyInput.value   = items["netmindKey"]   as string;
    if (items["netmindModel"]) netmindModelInput.value = items["netmindModel"] as string;
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

  // Persist only after successful test
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

  chrome.storage.sync.set(data, () => setStatus("Connected & saved!", "ok"));
});
