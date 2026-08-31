(() => {
  "use strict";

  if (globalThis.__YT_LIVE_CHAT_READER_STARTED__) {
    return;
  }
  globalThis.__YT_LIVE_CHAT_READER_STARTED__ = true;

  // YouTubeライブチャット固有のセレクタはここに集約する。
  const SELECTORS = Object.freeze({
    items: "yt-live-chat-item-list-renderer #items",
    renderer: [
      "yt-live-chat-text-message-renderer",
      "yt-live-chat-paid-message-renderer",
      "yt-live-chat-membership-item-renderer",
      "yt-live-chat-paid-sticker-renderer"
    ].join(","),
    author: "#author-name",
    message: "#message",
    authorIcon: "#author-photo img, img#img",
    membershipText: "#header-subtext",
    purchaseAmount: "#purchase-amount"
  });

  const MESSAGE_SOURCE = "yt-live-chat-overlay";
  const MAX_TRACKED_IDS = 1000;
  const INITIAL_MESSAGE_LIMIT = 100;
  const frameSessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  let rendererStates = new WeakMap();
  const seenIds = new Set();
  const seenIdQueue = [];
  let fallbackSequence = 0;
  let activeVideoId = null;
  let messageObserver = null;
  let rootObserver = null;
  let observedItems = new Set();
  let lastReaderStatus = null;

  function isExtensionContextInvalidated(error) {
    return /Extension context invalidated/i.test(String(error?.message ?? error));
  }

  function extensionContextIsAvailable() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    if (!extensionContextIsAvailable()) {
      disconnect();
      return;
    }

    try {
      chrome.runtime.sendMessage(message, () => {
        if (extensionContextIsAvailable()) {
          void chrome.runtime.lastError;
        }
      });
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        disconnect();
        return;
      }
      throw error;
    }
  }

  function isSupportedDocument() {
    return location.pathname === "/live_chat" || location.pathname === "/watch";
  }

  function getVideoId() {
    return new URL(location.href).searchParams.get("v");
  }

  function notifyReaderStatus(status) {
    if (status === lastReaderStatus) {
      return;
    }
    lastReaderStatus = status;

    sendRuntimeMessage({
      source: MESSAGE_SOURCE,
      type: "chat-reader-status",
      videoId: getVideoId(),
      status
    });
  }

  function getKind(renderer) {
    if (renderer.matches("yt-live-chat-paid-message-renderer")) {
      return "superchat";
    }
    if (renderer.matches("yt-live-chat-membership-item-renderer")) {
      return "membership";
    }
    if (renderer.matches("yt-live-chat-paid-sticker-renderer")) {
      return "sticker";
    }
    return "normal";
  }

  function rememberId(id) {
    if (seenIds.has(id)) {
      return false;
    }

    seenIds.add(id);
    seenIdQueue.push(id);
    if (seenIdQueue.length > MAX_TRACKED_IDS) {
      const oldestId = seenIdQueue.shift();
      seenIds.delete(oldestId);
    }
    return true;
  }

  function getElementContent(element) {
    if (!(element instanceof Element)) {
      return { text: "", segments: [], pendingImages: false };
    }

    const segments = [];
    let pendingImages = false;
    const appendText = (text) => {
      if (!text) {
        return;
      }
      const lastSegment = segments.at(-1);
      if (lastSegment?.type === "text") {
        lastSegment.text += text;
      } else {
        segments.push({ type: "text", text });
      }
    };

    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.textContent ?? "");
        return;
      }

      if (node instanceof HTMLImageElement) {
        const url = node.currentSrc || node.src;
        const alt = node.alt || "スタンプ";
        if (url) {
          segments.push({ type: "emoji", url, alt });
        } else {
          pendingImages = true;
          appendText(alt);
        }
        return;
      }

      if (node instanceof HTMLBRElement) {
        appendText("\n");
        return;
      }

      for (const child of node.childNodes) {
        visit(child);
      }
    };

    visit(element);
    const text = segments.map((segment) => (
      segment.type === "text" ? segment.text : segment.alt
    )).join("").trim();

    if (!text) {
      return { text: "", segments: [], pendingImages };
    }

    return { text, segments, pendingImages };
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function extractMessage(renderer) {
    if (!(renderer instanceof Element)) {
      return null;
    }

    const author = renderer.querySelector(SELECTORS.author)?.textContent?.trim() ?? "";
    const contents = [
      getElementContent(renderer.querySelector(SELECTORS.message)),
      getElementContent(renderer.querySelector(SELECTORS.membershipText)),
      getElementContent(renderer.querySelector(SELECTORS.purchaseAmount))
    ];
    const content = contents.find((candidate) => candidate.text) ?? {
      text: "",
      segments: [],
      pendingImages: false
    };
    const { text, segments } = content;

    if (!author || !text || content.pendingImages) {
      return null;
    }

    const domId = renderer.id || renderer.getAttribute("data-id");
    const kind = getKind(renderer);
    const stateKey = `${domId ?? ""}\u0000${author}\u0000${text}\u0000${kind}`;
    if (rendererStates.get(renderer) === stateKey) {
      return null;
    }
    rendererStates.set(renderer, stateKey);

    // renderer要素やDOM IDが再利用されても、内容が変われば別コメントとして扱う。
    const id = domId
      ? `${domId}:${hashText(`${author}\u0000${text}\u0000${kind}`)}`
      : `fallback-${frameSessionId}-${fallbackSequence++}`;
    if (!rememberId(id)) {
      return null;
    }

    const icon = renderer.querySelector(SELECTORS.authorIcon);
    return {
      id,
      author,
      text,
      segments,
      iconUrl: icon instanceof HTMLImageElement ? (icon.currentSrc || icon.src) : "",
      kind
    };
  }

  function sendChatMessage(renderer) {
    const message = extractMessage(renderer);
    const videoId = getVideoId();
    if (!message) {
      return;
    }

    sendRuntimeMessage({
      source: MESSAGE_SOURCE,
      type: "chat-message",
      videoId,
      message
    });
  }

  function collectRenderers(node, renderers) {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) {
      return;
    }

    const containingRenderer = element.closest(SELECTORS.renderer);
    if (containingRenderer) {
      renderers.add(containingRenderer);
    }

    for (const renderer of element.querySelectorAll(SELECTORS.renderer)) {
      renderers.add(renderer);
    }
  }

  function handleItemMutations(mutations) {
    const renderers = new Set();
    for (const mutation of mutations) {
      collectRenderers(mutation.target, renderers);
      for (const node of mutation.addedNodes) {
        collectRenderers(node, renderers);
      }
    }

    // PolymerがrendererのテキストやIDを書き換え終えるのを待ってまとめて処理する。
    queueMicrotask(() => {
      for (const renderer of renderers) {
        sendChatMessage(renderer);
      }
    });
  }

  function observeItems(items) {
    if (observedItems.has(items)) {
      return;
    }

    observedItems.add(items);
    notifyReaderStatus("observing");

    const existing = Array.from(items.querySelectorAll(SELECTORS.renderer));
    for (const renderer of existing.slice(-INITIAL_MESSAGE_LIMIT)) {
      sendChatMessage(renderer);
    }

    messageObserver ??= new MutationObserver(handleItemMutations);
    messageObserver.observe(items, {
      attributes: true,
      attributeFilter: ["id", "data-id", "src", "alt"],
      characterData: true,
      childList: true,
      subtree: true
    });
  }

  function observeRoot(observationRoot) {
    const refreshItems = () => {
      for (const items of observationRoot.querySelectorAll(SELECTORS.items)) {
        observeItems(items);
      }

      for (const items of observedItems) {
        if (!items.isConnected) {
          observedItems.delete(items);
        }
      }

      if (observedItems.size === 0) {
        notifyReaderStatus("waiting-items");
      }
    };

    refreshItems();
    rootObserver = new MutationObserver(refreshItems);
    rootObserver.observe(observationRoot, { childList: true, subtree: true });
  }

  function connect() {
    messageObserver?.disconnect();
    rootObserver?.disconnect();
    messageObserver = null;
    observedItems = new Set();

    if (!isSupportedDocument()) {
      return;
    }

    const nextVideoId = getVideoId();
    if (nextVideoId !== activeVideoId) {
      activeVideoId = nextVideoId;
      rendererStates = new WeakMap();
      seenIds.clear();
      seenIdQueue.length = 0;
      fallbackSequence = 0;
      lastReaderStatus = null;
    }

    const observationRoot = location.pathname === "/watch"
      ? document.fullscreenElement
      : document.documentElement;

    // 視聴ページではフルスクリーン領域だけを監視し、通常表示中のページ全体監視を避ける。
    if (!observationRoot) {
      if (location.pathname === "/live_chat") {
        notifyReaderStatus("waiting-dom");
        document.addEventListener("DOMContentLoaded", connect, { once: true });
      }
      return;
    }

    if (observationRoot.querySelectorAll(SELECTORS.items).length === 0) {
      notifyReaderStatus("waiting-items");
    }
    observeRoot(observationRoot);
  }

  function disconnect() {
    messageObserver?.disconnect();
    rootObserver?.disconnect();
    messageObserver = null;
    rootObserver = null;
    observedItems = new Set();
  }

  window.addEventListener("yt-navigate-finish", connect);
  document.addEventListener("fullscreenchange", connect);
  window.addEventListener("pagehide", disconnect, { once: true });
  connect();
})();
