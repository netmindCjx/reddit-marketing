// Content script — floating button + context-menu modal for Reddit AI replies
export {};

// Guard: if this script is injected a second time (on-demand inject), bail out early.
if ((window as unknown as Record<string, unknown>)["__aiReplyLoaded"]) {
  // Already running — nothing to do.
  throw new Error("__aiReplyLoaded");   // stops further execution of this module
}
(window as unknown as Record<string, unknown>)["__aiReplyLoaded"] = true;

// ── Styles ───────────────────────────────────────────────────────────────────
const style = document.createElement("style");
style.textContent = `
  /* Floating inline button */
  #ai-reply-floating-btn {
    position: fixed;
    z-index: 2147483646;
    padding: 6px 16px;
    background: #ff4500;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    border: none;
    border-radius: 20px;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0,0,0,0.28);
    transition: background 0.15s, transform 0.1s;
    display: none;
    pointer-events: auto;
    user-select: none;
  }
  #ai-reply-floating-btn:hover  { background: #e03d00; transform: translateY(-1px); }
  #ai-reply-floating-btn:active { transform: translateY(0); }
  #ai-reply-floating-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

  /* Modal overlay */
  #ai-reply-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #ai-reply-modal {
    background: #fff;
    border-radius: 12px;
    padding: 24px;
    width: 480px;
    max-width: 90vw;
    box-shadow: 0 8px 40px rgba(0,0,0,0.22);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  #ai-reply-modal h3 {
    margin: 0;
    font-size: 16px;
    color: #1a1a1b;
  }
  .ai-modal-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .5px;
    color: #878a8c;
    margin-bottom: 4px;
  }
  #ai-reply-quote {
    background: #f6f7f8;
    border-left: 3px solid #ff4500;
    border-radius: 4px;
    padding: 8px 12px;
    font-size: 13px;
    color: #3c3c3c;
    max-height: 80px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  #ai-reply-result {
    width: 100%;
    box-sizing: border-box;
    min-height: 110px;
    padding: 10px;
    border: 1px solid #edeff1;
    border-radius: 6px;
    font-size: 14px;
    color: #1a1a1b;
    resize: vertical;
    font-family: inherit;
    line-height: 1.5;
  }
  #ai-reply-result:focus { outline: 2px solid #ff4500; }
  .ai-modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .ai-modal-actions button {
    padding: 8px 20px;
    border-radius: 20px;
    border: none;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }
  #ai-copy-btn {
    background: #ff4500;
    color: #fff;
  }
  #ai-copy-btn:hover { background: #e03d00; }
  #ai-copy-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  #ai-regen-btn {
    background: #0079d3;
    color: #fff;
  }
  #ai-regen-btn:hover { background: #006cbd; }
  #ai-regen-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  #ai-close-btn {
    background: #edeff1;
    color: #1a1a1b;
  }
  #ai-close-btn:hover { background: #dae0e6; }
  .ai-status-text {
    font-size: 13px;
    color: #878a8c;
    text-align: center;
  }
`;
document.head.appendChild(style);

// ── Extension context guard ──────────────────────────────────────────────────
// After an extension reload the old content script instance stays alive but
// chrome.runtime becomes unavailable. Detect this and tell the user to refresh.

function isContextAlive(): boolean {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

async function safeSendMessage(msg: object): Promise<{ ok: boolean; reply?: string; error?: string }> {
  if (!isContextAlive()) {
    throw new Error("CONTEXT_INVALIDATED");
  }
  try {
    return await chrome.runtime.sendMessage(msg) as { ok: boolean; reply?: string; error?: string };
  } catch (err) {
    // After any failure, re-check — if context died mid-flight that's the real cause
    if (!isContextAlive()) throw new Error("CONTEXT_INVALIDATED");
    throw err;
  }
}

function isReloadError(err: unknown): boolean {
  const s = String(err);
  return s.includes("CONTEXT_INVALIDATED") || s.includes("context invalidated") || s.includes("Extension context");
}

// ── Floating button (appears when an editor is focused) ──────────────────────
const floatingBtn = document.createElement("button");
floatingBtn.id = "ai-reply-floating-btn";
floatingBtn.textContent = "✨ AI Reply";
document.body.appendChild(floatingBtn);

let currentEditor: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let isBusy = false;  // true while generating — suppress hide

function isReplyEditor(el: Element): boolean {
  const isContentEditable = el.getAttribute("contenteditable") === "true";
  const isTextarea = el.tagName === "TEXTAREA";
  if (!isContentEditable && !isTextarea) return false;
  if (el.closest('[role="search"], nav, header, [data-testid*="search"]')) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 80) return false;
  return true;
}

function positionFloatingBtn(editor: HTMLElement): void {
  const rect = editor.getBoundingClientRect();
  floatingBtn.style.top  = `${rect.bottom + 8}px`;
  floatingBtn.style.left = `${rect.left}px`;
  floatingBtn.style.display = "block";
}

function showFloatingBtn(editor: HTMLElement): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  currentEditor = editor;
  positionFloatingBtn(editor);
}

function cancelHide(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function hideBtn(): void {
  if (isBusy) return;
  floatingBtn.style.display = "none";
  currentEditor = null;
}

// Reposition on scroll
document.addEventListener("scroll", () => {
  if (currentEditor && floatingBtn.style.display !== "none") positionFloatingBtn(currentEditor);
}, { capture: true, passive: true });

// Show button when ANY reply editor gains focus
document.addEventListener("focusin", (e) => {
  const el = e.target as Element;
  if (isReplyEditor(el)) {
    cancelHide();
    showFloatingBtn(el as HTMLElement);
  }
}, true);

// Hide only when clicking OUTSIDE both the editor and the button.
// Do NOT use focusout — Reddit's reply box triggers many focus/blur cycles
// during expansion which cause the button to flash and disappear.
document.addEventListener("mousedown", (e) => {
  if (isBusy) return;
  if (floatingBtn.style.display === "none") return;
  const target = e.target as Node;
  // Keep visible if clicking on the button itself or inside the current editor
  if (floatingBtn.contains(target)) return;
  if (currentEditor?.contains(target)) return;
  // Also keep visible if clicking inside the editor's form container
  if (currentEditor) {
    const form = currentEditor.closest("form, [data-testid*='form'], [data-testid*='reply'], shreddit-composer");
    if (form?.contains(target)) return;
  }
  hideBtn();
}, true);

// ── Text insertion ───────────────────────────────────────────────────────────
function insertTextIntoEditor(editor: HTMLElement, text: string): void {
  editor.focus();
  if (editor.tagName === "TEXTAREA") {
    (editor as HTMLTextAreaElement).value = text;
    editor.dispatchEvent(new Event("input",  { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, "");
    document.execCommand("insertText", false, text);
  }
}

// ── Context helpers ──────────────────────────────────────────────────────────
function gatherPageReplies(): string[] {
  const replies: string[] = [];
  document.querySelectorAll("p").forEach((p) => {
    const t = p.textContent?.trim();
    if (t && t.length > 30 && replies.length < 3) replies.push(t);
  });
  return replies;
}

// ── Modal ────────────────────────────────────────────────────────────────────
function buildModal(): {
  overlay: HTMLDivElement;
  quoteEl: HTMLDivElement;
  resultEl: HTMLTextAreaElement;
  statusEl: HTMLParagraphElement;
  copyBtn: HTMLButtonElement;
  regenBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
} {
  const overlay = document.createElement("div");
  overlay.id = "ai-reply-overlay";

  overlay.innerHTML = `
    <div id="ai-reply-modal">
      <h3>✨ AI Reply Generator</h3>

      <div>
        <div class="ai-modal-label">Replying to</div>
        <div id="ai-reply-quote"></div>
      </div>

      <div>
        <div class="ai-modal-label">Generated reply <span style="font-weight:400;text-transform:none">(editable)</span></div>
        <textarea id="ai-reply-result" placeholder="Generating…" readonly></textarea>
      </div>

      <p class="ai-status-text" id="ai-modal-status">Generating reply…</p>

      <div class="ai-modal-actions">
        <button id="ai-close-btn">Close</button>
        <button id="ai-regen-btn" disabled>🔄 Regenerate</button>
        <button id="ai-copy-btn" disabled>Copy</button>
      </div>
    </div>
  `;

  return {
    overlay,
    quoteEl:  overlay.querySelector("#ai-reply-quote")   as HTMLDivElement,
    resultEl: overlay.querySelector("#ai-reply-result")  as HTMLTextAreaElement,
    statusEl: overlay.querySelector("#ai-modal-status")  as HTMLParagraphElement,
    copyBtn:  overlay.querySelector("#ai-copy-btn")      as HTMLButtonElement,
    regenBtn: overlay.querySelector("#ai-regen-btn")     as HTMLButtonElement,
    closeBtn: overlay.querySelector("#ai-close-btn")     as HTMLButtonElement,
  };
}

async function showReplyModal(selectedText: string): Promise<void> {
  const { overlay, quoteEl, resultEl, statusEl, copyBtn, regenBtn, closeBtn } = buildModal();
  document.body.appendChild(overlay);

  quoteEl.textContent = selectedText.slice(0, 400) + (selectedText.length > 400 ? "…" : "");

  function closeModal(): void { overlay.remove(); }
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", onEsc); }
  });

  // Shared generate function (used for first generate + regenerate)
  async function generate(): Promise<void> {
    resultEl.value = "";
    resultEl.setAttribute("readonly", "");
    resultEl.placeholder = "Generating…";
    copyBtn.disabled = true;
    regenBtn.disabled = true;
    statusEl.textContent = "Generating reply…";
    statusEl.style.color = "#878a8c";

    try {
      const res = await safeSendMessage({
        type: "GENERATE_REPLY",
        postText: selectedText.slice(0, 800),
        existingReplies: gatherPageReplies(),
      });

      if (!res.ok) throw new Error(res.error);

      resultEl.value = res.reply ?? "";
      resultEl.removeAttribute("readonly");
      copyBtn.disabled = false;
      regenBtn.disabled = false;
      statusEl.textContent = "Ready — edit if needed, then copy.";
    } catch (err) {
      regenBtn.disabled = false;  // allow retry on error
      if (isReloadError(err)) {
        statusEl.textContent = "Extension was reloaded — please refresh this page (Cmd+R).";
      } else {
        statusEl.textContent = `Error: ${String(err)}`;
      }
      statusEl.style.color = "#e53e3e";
    }
  }

  // First generate
  await generate();

  // Regenerate
  regenBtn.addEventListener("click", () => { generate().catch(() => {}); });

  // Copy to clipboard
  copyBtn.addEventListener("click", async () => {
    const text = resultEl.value.trim();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });
}

// ── Floating button → inline insert + retry ─────────────────────────────────
async function generateForEditor(editor: HTMLElement): Promise<void> {
  isBusy = true;
  floatingBtn.disabled = true;
  floatingBtn.textContent = "⏳ Generating…";

  try {
    const res = await safeSendMessage({
      type: "GENERATE_REPLY",
      postText: editor.textContent?.slice(0, 800) ?? "",
      existingReplies: gatherPageReplies(),
    });

    if (!res.ok) throw new Error(res.error);
    if (res.reply) insertTextIntoEditor(editor, res.reply);
    // After success, show retry button so user can regenerate
    floatingBtn.textContent = "🔄 Retry";
  } catch (err) {
    if (isReloadError(err)) {
      floatingBtn.textContent = "🔄 Reload page";
    } else {
      floatingBtn.textContent = "❌ Retry";
      console.warn("[AI Reply]", err);
    }
  } finally {
    isBusy = false;
    floatingBtn.disabled = false;
  }
}

floatingBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const editor = currentEditor;
  if (!editor || isBusy) return;
  generateForEditor(editor).catch(() => {});
});

// ── Listen for context menu trigger from background ──────────────────────────
try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "SHOW_REPLY_MODAL") {
      showReplyModal(message.selectedText as string).catch(() => { /* modal handles its own errors */ });
    }
  });
} catch {
  // Context already invalidated at load time — page needs a refresh.
}
