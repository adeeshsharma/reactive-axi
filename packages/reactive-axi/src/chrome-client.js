// The trusted top-level "chrome" page. Plain, unbundled script loaded via <script src> - no
// ES module imports, because it is served as a raw static file, not run through a bundler.
const sessionDataElement = document.getElementById("reactive-axi-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const projectRoot = String(sessionData.projectRoot || "");
const proxyUrl = String(sessionData.proxyUrl || "");
const stackLabel = String(sessionData.stackLabel || "");

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const frameWrap = /** @type {HTMLDivElement} */ (document.getElementById("frameWrap"));
const frameBadge = /** @type {HTMLDivElement} */ (document.getElementById("frameBadge"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("sendBtn"));
const endBtn = /** @type {HTMLButtonElement} */ (document.getElementById("endBtn"));
const presenceEl = /** @type {HTMLSpanElement} */ (document.getElementById("presence"));
const presenceLabel = /** @type {HTMLSpanElement} */ (document.getElementById("presenceLabel"));
const annotationHint = /** @type {HTMLDivElement} */ (document.getElementById("annotationHint"));
const projectRootLabel = /** @type {HTMLSpanElement} */ (document.getElementById("projectRootLabel"));
const stackLabelEl = /** @type {HTMLSpanElement} */ (document.getElementById("stackLabel"));
const modeSegAnnotate = /** @type {HTMLButtonElement} */ (document.getElementById("modeSegAnnotate"));
const modeSegExplore = /** @type {HTMLButtonElement} */ (document.getElementById("modeSegExplore"));
const annotationCard = /** @type {HTMLDivElement} */ (document.getElementById("annotationCard"));
const cardTarget = /** @type {HTMLSpanElement} */ (document.getElementById("cardTarget"));
const cardClose = /** @type {HTMLButtonElement} */ (document.getElementById("cardClose"));
const cardTypes = /** @type {HTMLDivElement} */ (document.getElementById("cardTypes"));
const cardInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("cardInput"));
const cardQueueBtn = /** @type {HTMLButtonElement} */ (document.getElementById("cardQueueBtn"));
const queueSection = /** @type {HTMLDivElement} */ (document.getElementById("queueSection"));
const queueCount = /** @type {HTMLSpanElement} */ (document.getElementById("queueCount"));
const queueList = /** @type {HTMLDivElement} */ (document.getElementById("queueList"));
const sessionEndedOverlay = /** @type {HTMLDivElement} */ (document.getElementById("sessionEndedOverlay"));
const sessionEndedNote = /** @type {HTMLParagraphElement} */ (document.getElementById("sessionEndedNote"));

projectRootLabel.textContent = projectRoot;
if (proxyUrl) frame.src = proxyUrl;
if (stackLabel) {
  stackLabelEl.textContent = stackLabel;
  stackLabelEl.hidden = false;
}

const KIND_LABELS = { change: "Change", question: "Question", comment: "Comment", bug: "Bug" };

// ---------------------------------------------------------------------------
// Session-ended lockout - a blocking overlay over the reviewed app itself (not just a status
// label in the corner), so it's unmissable that navigation/annotation no longer does anything.
// Driven entirely by the "session-ended" SSE event, which fires whether *this* tab ended the
// session or another one did (or the agent did, via `reactive-axi end`) - single source of
// truth instead of two divergent code paths for "I ended it" vs "it got ended".
// ---------------------------------------------------------------------------

let sessionEnded = false;

function showSessionEnded(endedBy) {
  if (sessionEnded) return;
  sessionEnded = true;
  closeCard();
  sessionEndedNote.textContent = endedBy === "agent" ? "The agent ended this session." : "This session was ended.";
  sessionEndedOverlay.hidden = false;
  modeSegAnnotate.disabled = true;
  modeSegExplore.disabled = true;
  sendBtn.disabled = true;
  chatInput.disabled = true;
  endBtn.disabled = true;
  endBtn.textContent = "Session ended";
}

// ---------------------------------------------------------------------------
// Annotate / explore mode
// ---------------------------------------------------------------------------

let annotateMode = true;

function applyModeUi() {
  modeSegAnnotate.setAttribute("aria-pressed", String(annotateMode));
  modeSegExplore.setAttribute("aria-pressed", String(!annotateMode));
  modeSegAnnotate.classList.toggle("active", annotateMode);
  modeSegExplore.classList.toggle("active", !annotateMode);
  frameWrap.classList.toggle("annotate-active", annotateMode);
  frameBadge.textContent = annotateMode ? "Annotate — click anything" : "Explore — live app";
  frameBadge.classList.toggle("explore", !annotateMode);
  if (!annotateMode) closeCard();
}

function setAnnotateMode(enabled) {
  if (sessionEnded) return;
  annotateMode = Boolean(enabled);
  applyModeUi();
  frame.contentWindow?.postMessage({ type: "reactive-axi:setAnnotateMode", enabled: annotateMode }, "*");
}

modeSegAnnotate.addEventListener("click", () => setAnnotateMode(true));
modeSegExplore.addEventListener("click", () => setAnnotateMode(false));
document.addEventListener("keydown", (event) => {
  if (sessionEnded) return;
  const isModI =
    (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "i";
  if (isModI) {
    event.preventDefault();
    setAnnotateMode(!annotateMode);
  }
});
applyModeUi();

// ---------------------------------------------------------------------------
// Floating annotation card - shown near the clicked element, lets the reviewer
// pick a kind and write a note before it's added to the queue below.
// ---------------------------------------------------------------------------

let pendingSelection = null; // the resolved click result the open card is attached to
let editingId = null; // set when the card is editing an existing queue item instead
let currentKind = "change";

function setCardKind(kind) {
  currentKind = KIND_LABELS[kind] ? kind : "change";
  for (const chip of cardTypes.querySelectorAll(".type-chip")) {
    chip.classList.toggle("active", chip.getAttribute("data-kind") === currentKind);
  }
}

cardTypes.addEventListener("click", (event) => {
  const chip = /** @type {HTMLElement} */ (event.target).closest(".type-chip");
  if (chip) setCardKind(chip.getAttribute("data-kind"));
});

function clampCardPosition(left, top) {
  const wrapRect = frameWrap.getBoundingClientRect();
  const cardWidth = 288;
  const cardHeight = annotationCard.offsetHeight || 224;
  const maxLeft = Math.max(8, wrapRect.width - cardWidth - 8);
  const maxTop = Math.max(8, wrapRect.height - cardHeight - 8);
  return { left: Math.min(Math.max(8, left), maxLeft), top: Math.min(Math.max(8, top), maxTop) };
}

function positionCardNear(rect) {
  const anchor = rect || { left: 40, top: 40, right: 160, bottom: 60 };
  const { left, top } = clampCardPosition(anchor.right + 12, anchor.top);
  annotationCard.style.left = `${left}px`;
  annotationCard.style.top = `${top}px`;
}

function openCardForSelection(result) {
  if (sessionEnded) return;
  pendingSelection = result;
  editingId = null;
  setCardKind("change");
  cardInput.value = "";
  positionCardNear(result.rect);
  cardTarget.textContent = result.componentName
    ? `${result.componentName} • ${result.selector || ""}`
    : result.selector || "element";
  cardTarget.title = cardTarget.textContent;
  annotationCard.hidden = false;
  cardInput.focus();
}

// Anchored to the rect captured on the *original element* at selection time (stored on the
// queue item itself), not to the queue row's own position in the sidebar - editing a queued
// note should reopen the card next to what it's actually about, on the live app.
function openCardForEdit(item) {
  if (sessionEnded) return;
  pendingSelection = null;
  editingId = item.id;
  setCardKind(item.kind);
  cardInput.value = item.text;
  positionCardNear(item.rect);
  cardTarget.textContent = item.label || "message";
  cardTarget.title = cardTarget.textContent;
  annotationCard.hidden = false;
  cardInput.focus();
}

function closeCard() {
  annotationCard.hidden = true;
  pendingSelection = null;
  editingId = null;
}

cardClose.addEventListener("click", closeCard);

function labelFor(target, fallback) {
  if (!target) return fallback;
  if (target.fileName) return `${target.fileName}${target.lineNumber ? ":" + target.lineNumber : ""}`;
  return target.componentName || target.selector || fallback;
}

function commitCard({ alsoSend }) {
  const text = cardInput.value.trim();
  if (!text) return;
  if (editingId) {
    const item = queue.find((entry) => entry.id === editingId);
    if (item) {
      item.kind = currentKind;
      item.text = text;
    }
  } else {
    // The resolution tag tells us which inspector produced this (react-fiber-inspector.js,
    // vue-inspector.js, or svelte-inspector.js) - the target `type` sent to the server has to
    // match, since session-store.js's normalizeTarget dispatches strictly on it and each
    // framework's normalizer strips to its own fixed field shape. Overincluding fields the
    // target type doesn't use (e.g. `transformedUrl` for a Vue target) is harmless - the
    // server-side normalizer only ever picks the fields its own shape declares.
    const targetType =
      pendingSelection?.resolution === "vue-component"
        ? "vue-component"
        : pendingSelection?.resolution === "svelte-component"
          ? "svelte-component"
          : "react-component";
    const target =
      pendingSelection && !pendingSelection.error
        ? {
            type: targetType,
            selector: pendingSelection.selector || "",
            componentName: pendingSelection.componentName || "",
            resolution: pendingSelection.resolution || "debugSource",
            fileName: pendingSelection.fileName || "",
            lineNumber: pendingSelection.lineNumber || 0,
            columnNumber: pendingSelection.columnNumber || 0,
            transformedUrl: pendingSelection.transformedUrl || "",
            transformedLine: pendingSelection.transformedLine || 0,
            transformedColumn: pendingSelection.transformedColumn || 0,
          }
        : null;
    queue.push({
      id: `q${++queueIdCounter}`,
      kind: currentKind,
      text,
      target,
      rect: pendingSelection && !pendingSelection.error ? pendingSelection.rect || null : null,
      label: target ? labelFor(target, pendingSelection.selector) : "General message",
    });
  }
  closeCard();
  renderQueue();
  if (alsoSend) send();
}

cardQueueBtn.addEventListener("click", () => commitCard({ alsoSend: false }));
cardInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeCard();
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    commitCard({ alsoSend: true });
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    commitCard({ alsoSend: false });
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  const msg = event.data || {};
  if (msg.type === "reactive-axi:selection") {
    if (msg.result?.error) {
      const original = annotationHint.textContent;
      annotationHint.textContent = `Couldn't resolve that element: ${msg.result.error}`;
      setTimeout(() => {
        annotationHint.textContent = original;
      }, 3000);
      return;
    }
    openCardForSelection(msg.result);
  }
  if (msg.type === "reactive-axi:toggleAnnotateMode") {
    setAnnotateMode(!annotateMode);
  }
});

// ---------------------------------------------------------------------------
// Queue - everything staged but not yet sent. Kept visually separate from the
// Conversation history above the composer, so it's always obvious what's still
// a draft versus what the agent has already received.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ type: string, selector: string, componentName: string, resolution: string,
 *   fileName: string, lineNumber: number, columnNumber: number, transformedUrl: string,
 *   transformedLine: number, transformedColumn: number }} QueueItemTarget
 * @typedef {{ top: number, left: number, right: number, bottom: number, width: number, height: number }} QueueItemRect
 * @type {{ id: string, kind: string, text: string, target: QueueItemTarget | null, rect: QueueItemRect | null, label: string }[]}
 */
const queue = [];
let queueIdCounter = 0;

function renderQueue() {
  queueSection.hidden = queue.length === 0;
  queueCount.textContent = String(queue.length);
  queueList.innerHTML = "";
  for (const item of queue) {
    const row = document.createElement("div");
    row.className = "queue-item";
    row.dataset.kind = item.kind;

    const body = document.createElement("div");
    body.className = "queue-item-body";
    const label = document.createElement("div");
    label.className = "queue-item-label";
    label.textContent = `${KIND_LABELS[item.kind] || "Change"} • ${item.label}`;
    const text = document.createElement("div");
    text.className = "queue-item-text";
    text.textContent = item.text;
    body.append(label, text);

    const actions = document.createElement("div");
    actions.className = "queue-item-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openCardForEdit(item));
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      const index = queue.findIndex((entry) => entry.id === item.id);
      if (index !== -1) queue.splice(index, 1);
      renderQueue();
    });
    actions.append(editBtn, removeBtn);

    row.append(body, actions);
    queueList.appendChild(row);
  }
  updateSendButtonLabel();
}

// ---------------------------------------------------------------------------
// Conversation history + composer
// ---------------------------------------------------------------------------

function appendMessage(role, text, kind) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (kind && KIND_LABELS[kind]) {
    const badge = document.createElement("span");
    badge.className = "msg-kind";
    badge.dataset.kind = kind;
    badge.textContent = KIND_LABELS[kind];
    badge.style.color = `var(--kind-${kind})`;
    badge.style.background = `var(--kind-${kind}-soft)`;
    div.appendChild(badge);
    div.appendChild(document.createElement("br"));
  }
  div.appendChild(document.createTextNode(text));
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderChat(chat) {
  chatLog.innerHTML = "";
  for (const entry of chat) appendMessage(entry.role, entry.text, entry.kind);
}

renderChat(sessionData.initialChat || []);
renderQueue();

function updateSendButtonLabel() {
  const draftCount = chatInput.value.trim() ? 1 : 0;
  const total = queue.length + draftCount;
  sendBtn.textContent = total > 0 ? `Send to agent (${total})` : "Send to agent";
}
chatInput.addEventListener("input", updateSendButtonLabel);

async function send() {
  if (sessionEnded) return;
  const draftText = chatInput.value.trim();
  const prompts = queue.map((item) => ({
    prompt: item.text,
    tag: item.target ? "element" : "message",
    kind: item.kind,
    selector: item.target?.selector || "",
    text: item.text.slice(0, 200),
    ...(item.target ? { target: item.target } : {}),
  }));
  if (draftText) {
    prompts.push({ prompt: draftText, tag: "message", kind: "comment", selector: "", text: draftText.slice(0, 200) });
  }
  if (prompts.length === 0) return;

  await fetch(`/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts }),
  });

  for (const item of queue) appendMessage("user", item.text, item.kind);
  if (draftText) appendMessage("user", draftText, "comment");

  queue.length = 0;
  chatInput.value = "";
  renderQueue();
}

sendBtn.addEventListener("click", send);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    send();
  }
});

endBtn.addEventListener("click", async () => {
  if (sessionEnded) return;
  endBtn.disabled = true;
  endBtn.textContent = "Ending…";
  await fetch(`/api/${key}/end`, { method: "POST" });
  // Final state (disabling everything, showing the overlay) is applied by the
  // "session-ended" SSE event below, once the server confirms it - the same path used whether
  // this tab, another tab, or the agent itself is the one ending the session.
});

const events = new EventSource(`/events/${key}`);
events.addEventListener("chat-sync", (event) => {
  const { chat } = JSON.parse(event.data);
  renderChat(chat);
});
events.addEventListener("agent-reply", (event) => {
  const { text } = JSON.parse(event.data);
  appendMessage("agent", text);
});
events.addEventListener("agent-presence", (event) => {
  const { state } = JSON.parse(event.data);
  presenceEl.dataset.state = state;
  presenceLabel.textContent = state;
});
events.addEventListener("session-ended", (event) => {
  const { ended_by } = JSON.parse(event.data);
  showSessionEnded(ended_by);
});
