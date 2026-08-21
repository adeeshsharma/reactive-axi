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
const chatThumbs = /** @type {HTMLDivElement} */ (document.getElementById("chatThumbs"));
const chatFileInput = /** @type {HTMLInputElement} */ (document.getElementById("chatFileInput"));
const chatAttachBtn = /** @type {HTMLButtonElement} */ (document.getElementById("chatAttachBtn"));
const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("sendBtn"));
const endBtn = /** @type {HTMLButtonElement} */ (document.getElementById("endBtn"));
const presenceEl = /** @type {HTMLSpanElement} */ (document.getElementById("presence"));
const presenceLabel = /** @type {HTMLSpanElement} */ (document.getElementById("presenceLabel"));
const annotationHint = /** @type {HTMLDivElement} */ (document.getElementById("annotationHint"));
const projectRootLabel = /** @type {HTMLSpanElement} */ (document.getElementById("projectRootLabel"));
const stackLabelEl = /** @type {HTMLSpanElement} */ (document.getElementById("stackLabel"));
const modeSegAnnotate = /** @type {HTMLButtonElement} */ (document.getElementById("modeSegAnnotate"));
const modeSegExplore = /** @type {HTMLButtonElement} */ (document.getElementById("modeSegExplore"));
const modeShortcutHint = /** @type {HTMLElement} */ (document.getElementById("modeShortcutHint"));
const refreshAppBtn = /** @type {HTMLButtonElement} */ (document.getElementById("refreshAppBtn"));
const layoutEl = /** @type {HTMLDivElement} */ (document.getElementById("layout"));
const panelToggle = /** @type {HTMLButtonElement} */ (document.getElementById("panelToggle"));
const typingBubble = /** @type {HTMLDivElement} */ (document.getElementById("typingBubble"));
const annotationCard = /** @type {HTMLDivElement} */ (document.getElementById("annotationCard"));
const cardTarget = /** @type {HTMLSpanElement} */ (document.getElementById("cardTarget"));
const cardClose = /** @type {HTMLButtonElement} */ (document.getElementById("cardClose"));
const cardTypes = /** @type {HTMLDivElement} */ (document.getElementById("cardTypes"));
const cardInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("cardInput"));
const cardQueueBtn = /** @type {HTMLButtonElement} */ (document.getElementById("cardQueueBtn"));
const cardThumbs = /** @type {HTMLDivElement} */ (document.getElementById("cardThumbs"));
const cardFileInput = /** @type {HTMLInputElement} */ (document.getElementById("cardFileInput"));
const cardAttachBtn = /** @type {HTMLButtonElement} */ (document.getElementById("cardAttachBtn"));
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

// Cmd on macOS/iOS, Ctrl everywhere else - matches the modifier setAnnotateMode's own
// keydown handler below actually checks (event.metaKey || event.ctrlKey), just made visible.
const isApplePlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
modeShortcutHint.textContent = isApplePlatform ? "⌘I" : "Ctrl I";

// Reloads only the iframe's own document - not this chrome page, not the dev server, not the
// proxy. Setting src to about:blank then back forces a real navigation (a same-value
// reassignment can be silently coalesced by the browser); the target app's own HMR client
// reconnects the same way it always does after any normal page load, nothing here talks to
// dev-server-manager.js or proxy.js.
refreshAppBtn.addEventListener("click", () => {
  const current = frame.src;
  if (!current) return;
  frame.src = "about:blank";
  requestAnimationFrame(() => {
    frame.src = current;
  });
});

const KIND_LABELS = { change: "Change", question: "Question", comment: "Comment", bug: "Bug" };

// ---------------------------------------------------------------------------
// Image attachments - shared paste/upload handling for the annotation card
// and the general composer. Each accepted image uploads immediately (on
// paste or file selection, not batched with the eventual Queue/Send), so the
// reviewer sees a thumbnail right away and a queued/sent prompt only ever
// carries a small {id, path, mime} reference - never raw bytes.
// ---------------------------------------------------------------------------

// Duplicated from session-store.js's MAX_ATTACHMENTS/ATTACHMENT_MIME_TYPES -
// this file is served raw with no bundler and no ES module imports (see the
// top-of-file comment), so it can't share those constants directly. Keep
// both in sync by hand if either changes.
const MAX_ATTACHMENTS_PER_MESSAGE = 6;
const ACCEPTED_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** @typedef {{ id: string, path: string, mime: string, objectUrl: string }} Attachment */

async function uploadAttachment(blob) {
  const res = await fetch(`/api/${key}/attachments`, {
    method: "POST",
    headers: { "content-type": blob.type },
    body: blob,
  });
  if (!res.ok) return null;
  const saved = await res.json();
  return { id: saved.id, path: saved.path, mime: saved.mime, objectUrl: URL.createObjectURL(blob) };
}

function renderThumbs(container, attachments, onRemove) {
  container.innerHTML = "";
  container.hidden = attachments.length === 0;
  for (const attachment of attachments) {
    const chip = document.createElement("div");
    chip.className = "thumb-chip";
    const img = document.createElement("img");
    img.src = attachment.objectUrl;
    img.alt = "attached image";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "thumb-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", "Remove image");
    removeBtn.addEventListener("click", () => onRemove(attachment.id));
    chip.append(img, removeBtn);
    container.appendChild(chip);
  }
}

// One controller per attach point (annotation card, composer). `onChange`
// lets a caller (e.g. the composer's send-button label) react to uploads/
// removals without this module needing to know about send-button state.
function createAttachmentController(container, onChange) {
  let list = /** @type {Attachment[]} */ ([]);

  function refresh() {
    renderThumbs(container, list, remove);
    onChange?.();
  }

  // Intentionally does NOT call URL.revokeObjectURL here. After forQueue() has
  // been called once (committing a card to the queue), a queue item's own
  // attachments array holds copies of these same objectUrl strings - if the
  // reviewer later reopens that item for edit (restore()) and removes a chip
  // there, revoking would break the original queue item's thumbnail too if
  // the edit is then cancelled instead of re-committed. Blob URLs are freed
  // automatically when the page unloads; the bounded per-session retention
  // until then is an accepted tradeoff, not an oversight.
  function remove(id) {
    list = list.filter((attachment) => attachment.id !== id);
    refresh();
  }

  async function addFiles(fileList) {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - list.length;
    if (room <= 0) return;
    const accepted = Array.from(fileList)
      .filter((file) => ACCEPTED_ATTACHMENT_TYPES.has(file.type))
      .slice(0, room);
    const uploaded = (await Promise.all(accepted.map(uploadAttachment))).filter(Boolean);
    list = [...list, ...uploaded];
    refresh();
  }

  // Strips down to what the server accepts on a prompt - never send the
  // browser-local objectUrl.
  function forSend() {
    return list.map(({ id, path, mime }) => ({ id, path, mime }));
  }

  // Full local shape (including objectUrl), for stashing on a queue item so
  // it can be re-rendered (queue thumbnails, re-opening for edit) without a
  // round trip.
  function forQueue() {
    return list.map((attachment) => ({ ...attachment }));
  }

  // Resets this controller's own list WITHOUT revoking objectUrls - ownership
  // of those blob: URLs passes to whatever forQueue() snapshot was taken
  // (e.g. a queue item), which still needs them to render later. Only an
  // explicit remove() (before the item is ever queued) revokes.
  function clear() {
    list = [];
    refresh();
  }

  // Editing a queued item: the blob: object URLs created when these were
  // first uploaded are still valid for this page's lifetime, so redisplaying
  // them needs no re-fetch or server round trip.
  function restore(attachments) {
    list = attachments.map((attachment) => ({ ...attachment }));
    refresh();
  }

  return { addFiles, forSend, forQueue, clear, restore };
}

function wireAttachInput(textareaEl, fileInputEl, attachBtnEl, controller) {
  attachBtnEl.addEventListener("click", () => fileInputEl.click());
  fileInputEl.addEventListener("change", () => {
    if (sessionEnded) return;
    if (fileInputEl.files && fileInputEl.files.length > 0) controller.addFiles(fileInputEl.files);
    fileInputEl.value = "";
  });
  textareaEl.addEventListener("paste", (event) => {
    if (sessionEnded) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const files = Array.from(items)
      .filter((item) => item.kind === "file" && ACCEPTED_ATTACHMENT_TYPES.has(item.type))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) controller.addFiles(files);
  });
}

const cardAttachmentsCtl = createAttachmentController(cardThumbs);
const chatAttachmentsCtl = createAttachmentController(chatThumbs, () => updateSendButtonLabel());
wireAttachInput(cardInput, cardFileInput, cardAttachBtn, cardAttachmentsCtl);
wireAttachInput(chatInput, chatFileInput, chatAttachBtn, chatAttachmentsCtl);

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
// Chat panel collapse - pure screen-real-estate toggle for the iframe, no
// persistence across reloads (starts expanded every time), no server involvement.
// ---------------------------------------------------------------------------

let panelCollapsed = false;

function applyPanelCollapse() {
  layoutEl.classList.toggle("panel-collapsed", panelCollapsed);
  panelToggle.textContent = panelCollapsed ? "‹" : "›";
  panelToggle.setAttribute("aria-expanded", String(!panelCollapsed));
  const label = panelCollapsed ? "Expand panel" : "Collapse panel";
  panelToggle.title = label;
  panelToggle.setAttribute("aria-label", label);
}

panelToggle.addEventListener("click", () => {
  panelCollapsed = !panelCollapsed;
  applyPanelCollapse();
});

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
  cardAttachmentsCtl.clear();
  positionCardNear(result.rect);
  // `result.clicked.componentName` for the three paths already fully resolved client-side
  // (debugSource, vue-component, svelte-component - always null for the latter, an honest
  // Svelte limitation, see svelte-inspector.js); `result.componentName` (top-level, raw wire
  // shape) for React's debugStack path, whose clicked/anchor split doesn't exist yet until
  // resolveReactComponentTarget runs server-side.
  const displayName = result.clicked?.componentName || result.componentName;
  cardTarget.textContent = displayName ? `${displayName} • ${result.selector || ""}` : result.selector || "element";
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
  cardAttachmentsCtl.restore(item.attachments || []);
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
  cardAttachmentsCtl.clear();
}

cardClose.addEventListener("click", closeCard);

function labelFor(target, fallback) {
  if (!target) return fallback;
  const clicked = target.clicked;
  if (clicked?.fileName) return `${clicked.fileName}${clicked.lineNumber ? ":" + clicked.lineNumber : ""}`;
  // Falls back to `target.componentName` (the raw, top-level, pre-resolution field) for a
  // React debugStack target queued before resolveReactComponentTarget has run server-side -
  // `target.clicked` doesn't exist yet at that point, so there's no clicked.componentName to
  // read; the raw wire shape still carries a componentName directly, same as before this
  // redesign.
  return clicked?.componentName || target.componentName || target.selector || fallback;
}

function commitCard({ alsoSend }) {
  const text = cardInput.value.trim();
  if (!text) return;
  if (editingId) {
    const item = queue.find((entry) => entry.id === editingId);
    if (item) {
      item.kind = currentKind;
      item.text = text;
      item.attachments = cardAttachmentsCtl.forQueue();
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
            resolution: pendingSelection.resolution || "debugSource",
            ...(pendingSelection.clicked
              ? {
                  // Already fully resolved client-side - debugSource (React <=18),
                  // vue-component, or svelte-component all produce clicked/anchor/ancestry
                  // directly (see each inspector's own resolveClickTarget). Forwarded as-is;
                  // session-store.js's normalizers read clicked/anchor/ancestry straight from
                  // here.
                  clicked: pendingSelection.clicked,
                  anchor: pendingSelection.anchor || null,
                  ancestry: Array.isArray(pendingSelection.ancestry) ? pendingSelection.ancestry : [],
                }
              : {
                  // React's debugStack path (19+) - not resolved yet at queue time. These raw
                  // fields (react-fiber-inspector.js's resolveClickTarget) let
                  // resolveReactComponentTarget do the sourcemap round trip server-side and
                  // produce clicked/anchor itself once the item is actually sent. Must be
                  // forwarded exactly as received - dropping any of these silently breaks that
                  // resolution, the exact bug class fallbackCandidates and
                  // vendorSource/vendorPackage both hit earlier in this project's history.
                  componentName: pendingSelection.componentName || "",
                  transformedUrl: pendingSelection.transformedUrl || "",
                  transformedLine: pendingSelection.transformedLine || 0,
                  transformedColumn: pendingSelection.transformedColumn || 0,
                  ...(Array.isArray(pendingSelection.fallbackCandidates)
                    ? { fallbackCandidates: pendingSelection.fallbackCandidates }
                    : {}),
                  ancestry: Array.isArray(pendingSelection.ancestry) ? pendingSelection.ancestry : [],
                }),
          }
        : null;
    queue.push({
      id: `q${++queueIdCounter}`,
      kind: currentKind,
      text,
      target,
      rect: pendingSelection && !pendingSelection.error ? pendingSelection.rect || null : null,
      label: target ? labelFor(target, pendingSelection.selector) : "General message",
      attachments: cardAttachmentsCtl.forQueue(),
    });
  }
  cardAttachmentsCtl.clear();
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
 * @typedef {{ componentName: string | null, fileName: string, lineNumber: number | null,
 *   columnNumber: number | null, vendor?: boolean, vendorPackage?: string, note?: string,
 *   unresolved?: boolean }} QueueItemLocation
 * @typedef {{ type: string, selector: string, resolution: string, clicked?: QueueItemLocation,
 *   anchor?: QueueItemLocation | null, ancestry?: string[], componentName?: string,
 *   transformedUrl?: string, transformedLine?: number, transformedColumn?: number,
 *   fallbackCandidates?: unknown[] }} QueueItemTarget
 * @typedef {{ top: number, left: number, right: number, bottom: number, width: number, height: number }} QueueItemRect
 * @type {{ id: string, kind: string, text: string, target: QueueItemTarget | null, rect: QueueItemRect | null, label: string, attachments?: Attachment[] }[]}
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
    if (Array.isArray(item.attachments) && item.attachments.length > 0) {
      const thumbs = document.createElement("div");
      thumbs.className = "queue-item-thumbs";
      for (const attachment of item.attachments) {
        const img = document.createElement("img");
        img.src = attachment.objectUrl;
        img.alt = "attached image";
        thumbs.appendChild(img);
      }
      body.appendChild(thumbs);
    }

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

function appendMessage(role, text, kind, attachments) {
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
  if (text) div.appendChild(document.createTextNode(text));
  if (Array.isArray(attachments) && attachments.length > 0) {
    const thumbs = document.createElement("div");
    thumbs.className = "msg-thumbs";
    const withPreview = attachments.filter((attachment) => attachment.objectUrl);
    if (withPreview.length > 0) {
      for (const attachment of withPreview) {
        const img = document.createElement("img");
        img.src = attachment.objectUrl;
        img.alt = "attached image";
        thumbs.appendChild(img);
      }
    } else {
      // Synced from session.chat (e.g. a reload or a second tab) - the blob:
      // URL created at upload time only exists in the tab that made it, so
      // there is nothing displayable to re-fetch here. Say what's attached
      // instead of showing a broken image.
      const note = document.createElement("span");
      note.className = "msg-thumbs-note";
      note.textContent = `📎 ${attachments.length} image${attachments.length > 1 ? "s" : ""} attached`;
      thumbs.appendChild(note);
    }
    div.appendChild(thumbs);
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderChat(chat) {
  chatLog.innerHTML = "";
  for (const entry of chat) appendMessage(entry.role, entry.text, entry.kind, entry.attachments);
}

renderChat(sessionData.initialChat || []);
renderQueue();

function updateSendButtonLabel() {
  const hasDraft = Boolean(chatInput.value.trim()) || chatAttachmentsCtl.forSend().length > 0;
  const total = queue.length + (hasDraft ? 1 : 0);
  sendBtn.textContent = total > 0 ? `Send to agent (${total})` : "Send to agent";
}
chatInput.addEventListener("input", updateSendButtonLabel);

async function send() {
  if (sessionEnded) return;
  const draftText = chatInput.value.trim();
  const draftAttachmentsForSend = chatAttachmentsCtl.forSend();
  const prompts = queue.map((item) => ({
    prompt: item.text,
    tag: item.target ? "element" : "message",
    kind: item.kind,
    selector: item.target?.selector || "",
    text: item.text.slice(0, 200),
    ...(item.target ? { target: item.target } : {}),
    ...(item.attachments && item.attachments.length > 0
      ? { attachments: item.attachments.map(({ id, path, mime }) => ({ id, path, mime })) }
      : {}),
  }));
  if (draftText || draftAttachmentsForSend.length > 0) {
    prompts.push({
      prompt: draftText,
      tag: "message",
      kind: "comment",
      selector: "",
      text: draftText.slice(0, 200),
      ...(draftAttachmentsForSend.length > 0 ? { attachments: draftAttachmentsForSend } : {}),
    });
  }
  if (prompts.length === 0) return;

  await fetch(`/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts }),
  });

  for (const item of queue) appendMessage("user", item.text, item.kind, item.attachments);
  if (draftText || draftAttachmentsForSend.length > 0) {
    appendMessage("user", draftText, "comment", chatAttachmentsCtl.forQueue());
  }

  queue.length = 0;
  chatInput.value = "";
  chatAttachmentsCtl.clear();
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

// "working" (queued feedback already delivered to the agent, per computePresence in
// server.js) is the only state that means the agent is actually processing something right
// now - the bubble mirrors that exactly, not "listening" (agent idle, waiting for input).
function setTypingBubbleVisible(visible) {
  typingBubble.hidden = !visible;
  if (visible) chatLog.scrollTop = chatLog.scrollHeight;
}

const events = new EventSource(`/events/${key}`);
events.addEventListener("chat-sync", (event) => {
  const { chat } = JSON.parse(event.data);
  renderChat(chat);
});
events.addEventListener("agent-reply", (event) => {
  const { text } = JSON.parse(event.data);
  setTypingBubbleVisible(false);
  appendMessage("agent", text);
});
events.addEventListener("agent-presence", (event) => {
  const { state } = JSON.parse(event.data);
  presenceEl.dataset.state = state;
  presenceLabel.textContent = state;
  setTypingBubbleVisible(state === "working");
});
events.addEventListener("session-ended", (event) => {
  const { ended_by } = JSON.parse(event.data);
  showSessionEnded(ended_by);
});
