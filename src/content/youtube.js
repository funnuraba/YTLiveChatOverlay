(() => {
  "use strict";

  if (window.top !== window) {
    return;
  }

  const namespace = globalThis.__YT_LIVE_OVERLAY__;
  const settingsApi = globalThis.__YT_LIVE_OVERLAY_SETTINGS__;
  if (!namespace?.OverlayView || !settingsApi || namespace.controllerStarted) {
    return;
  }
  namespace.controllerStarted = true;

  // YouTube固有のトップページ側セレクタはここに集約する。
  const SELECTORS = Object.freeze({
    chatFrame: [
      "ytd-live-chat-frame iframe#chatframe",
      "iframe#chatframe[src*='/live_chat?']"
    ].join(","),
    liveMarker: [
      "ytd-watch-flexy[is-live]",
      "ytd-watch-flexy[is-live-content]",
      "#movie_player.ytp-live",
      ".ytp-live-badge:not([disabled])"
    ].join(",")
  });

  const MESSAGE_SOURCE = "yt-live-chat-overlay";
  const MAX_MESSAGES = 100;
  const MAX_SEEN_IDS = 500;
  const overlay = new namespace.OverlayView(MAX_MESSAGES, {
    onSettingsCommit: handleDirectSettingsCommit
  });
  const state = {
    enabled: true,
    overlaySettings: settingsApi.normalize(settingsApi.defaults),
    videoId: getVideoId(),
    hasLiveChat: false,
    messages: [],
    receivedTotal: 0,
    seenIds: new Set(),
    seenIdQueue: [],
    readerStatuses: new Map(),
    keepAliveFrame: null,
    refreshQueued: false
  };

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

  function saveLocalSettings(values) {
    if (!extensionContextIsAvailable()) {
      removeKeepAliveFrame();
      overlay.unmount();
      return;
    }

    try {
      chrome.storage.local.set(values);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        removeKeepAliveFrame();
        overlay.unmount();
        return;
      }
      throw error;
    }
  }

  function getVideoId() {
    const url = new URL(location.href);
    return url.pathname === "/watch" ? url.searchParams.get("v") : null;
  }

  function chatFrameIsLive() {
    const frame = document.querySelector(SELECTORS.chatFrame);
    if (!frame) {
      return false;
    }

    try {
      const url = new URL(frame.src, location.href);
      return url.pathname === "/live_chat";
    } catch {
      return false;
    }
  }

  function isLiveWatchPage() {
    return Boolean(
      state.videoId &&
      (state.hasLiveChat || chatFrameIsLive() || document.querySelector(SELECTORS.liveMarker))
    );
  }

  function getLiveChatUrl() {
    const nativeFrame = document.querySelector(SELECTORS.chatFrame);
    if (nativeFrame instanceof HTMLIFrameElement) {
      try {
        const nativeUrl = new URL(nativeFrame.src, location.href);
        if (nativeUrl.origin === location.origin && nativeUrl.pathname === "/live_chat") {
          return nativeUrl.href;
        }
      } catch {
        // 下のフォールバックURLを使用する。
      }
    }

    if (!state.videoId) {
      return null;
    }

    const fallbackUrl = new URL("/live_chat", location.origin);
    fallbackUrl.searchParams.set("v", state.videoId);
    fallbackUrl.searchParams.set("embed_domain", location.hostname);
    return fallbackUrl.href;
  }

  function removeKeepAliveFrame() {
    state.keepAliveFrame?.remove();
    state.keepAliveFrame = null;
  }

  function ensureKeepAliveFrame() {
    if (state.keepAliveFrame?.isConnected) {
      return;
    }

    const chatUrl = getLiveChatUrl();
    if (!chatUrl || !document.body) {
      return;
    }

    const frame = document.createElement("iframe");
    frame.id = "yt-live-overlay-chat-keepalive";
    frame.src = chatUrl;
    frame.title = "";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = [
      "position:fixed!important",
      "top:0!important",
      "left:0!important",
      "width:400px!important",
      "height:600px!important",
      "border:0!important",
      "opacity:.001!important",
      "clip-path:inset(100%)!important",
      "pointer-events:none!important",
      "z-index:-2147483648!important"
    ].join(";");

    document.body.append(frame);
    state.keepAliveFrame = frame;
  }

  function rememberMessageId(id) {
    if (state.seenIds.has(id)) {
      return false;
    }

    state.seenIds.add(id);
    state.seenIdQueue.push(id);

    if (state.seenIdQueue.length > MAX_SEEN_IDS) {
      const oldestId = state.seenIdQueue.shift();
      state.seenIds.delete(oldestId);
    }

    return true;
  }

  function normalizeMessage(message) {
    if (!message || typeof message !== "object") {
      return null;
    }

    const author = typeof message.author === "string" ? message.author.trim() : "";
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const id = typeof message.id === "string" ? message.id : "";

    if (!id || !author || !text) {
      return null;
    }

    const segments = [];
    if (Array.isArray(message.segments)) {
      for (const segment of message.segments.slice(0, 100)) {
        if (segment?.type === "text" && typeof segment.text === "string") {
          segments.push({ type: "text", text: segment.text.slice(0, 1000) });
          continue;
        }

        if (segment?.type === "emoji" && typeof segment.url === "string") {
          try {
            const url = new URL(segment.url, location.href);
            if (url.protocol === "https:" && url.href.length <= 2048) {
              segments.push({
                type: "emoji",
                url: url.href,
                alt: typeof segment.alt === "string" ? segment.alt.slice(0, 100) : "スタンプ"
              });
            }
          } catch {
            // 不正な画像URLは表示しない。
          }
        }
      }
    }

    return {
      id,
      author: author.slice(0, 100),
      text: text.slice(0, 1000),
      segments: segments.length > 0 ? segments : [{ type: "text", text: text.slice(0, 1000) }],
      iconUrl: typeof message.iconUrl === "string" ? message.iconUrl : "",
      kind: ["normal", "superchat", "membership", "sticker"].includes(message.kind)
        ? message.kind
        : "normal"
    };
  }

  function handleChatMessage(data) {
    if (data?.source !== MESSAGE_SOURCE || data.type !== "chat-message") {
      return;
    }

    if (!state.videoId || (data.videoId && data.videoId !== state.videoId)) {
      return;
    }

    const message = normalizeMessage(data.message);
    if (!message || !rememberMessageId(message.id)) {
      return;
    }

    state.hasLiveChat = true;
    state.receivedTotal += 1;
    state.messages.push(message);
    if (state.messages.length > MAX_MESSAGES) {
      state.messages.splice(0, state.messages.length - MAX_MESSAGES);
    }

    if (shouldShowOverlay()) {
      overlay.mount(document.fullscreenElement);
      overlay.add(message);
    }
  }

  function describeElement(element) {
    if (!(element instanceof Element)) {
      return "なし";
    }

    const id = element.id ? `#${element.id}` : "";
    const classes = Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join("");
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  }

  function getDiagnostics() {
    const fullscreenElement = document.fullscreenElement;
    const readers = Array.from(state.readerStatuses.values());
    return {
      version: chrome.runtime.getManifest().version,
      enabled: state.enabled,
      videoId: state.videoId,
      fullscreen: Boolean(fullscreenElement),
      fullscreenElement: describeElement(fullscreenElement),
      live: isLiveWatchPage(),
      liveMarker: Boolean(document.querySelector(SELECTORS.liveMarker)),
      liveChatFrame: chatFrameIsLive(),
      receivedMessages: state.receivedTotal,
      retainedMessages: state.messages.length,
      messageLimit: MAX_MESSAGES,
      overlayMounted: overlay.isMounted(),
      keepAlive: Boolean(state.keepAliveFrame?.isConnected),
      readers
    };
  }

  function handleRuntimeMessage(data, _sender, sendResponse) {
    if (data?.source !== MESSAGE_SOURCE) {
      return;
    }

    if (data.type === "get-diagnostics") {
      sendResponse(getDiagnostics());
      return;
    }

    if (data.type === "chat-reader-status") {
      const frameId = data.relay?.frameId ?? "unknown";
      state.readerStatuses.set(frameId, data.status);
      return;
    }

    if (data.type === "chat-message") {
      handleChatMessage(data);
    }
  }

  function shouldShowOverlay() {
    return state.enabled && Boolean(document.fullscreenElement) && isLiveWatchPage();
  }

  function handleDirectSettingsCommit(settings) {
    state.overlaySettings = settingsApi.normalize(settings);
    saveLocalSettings({
      [settingsApi.storageKey]: state.overlaySettings
    });
  }

  function syncOverlay() {
    if (!shouldShowOverlay()) {
      removeKeepAliveFrame();
      overlay.unmount();
      return;
    }

    ensureKeepAliveFrame();
    if (overlay.mount(document.fullscreenElement)) {
      overlay.replace(state.messages);
    }
  }

  function resetForNavigation() {
    const nextVideoId = getVideoId();
    if (nextVideoId !== state.videoId) {
      state.videoId = nextVideoId;
      state.hasLiveChat = false;
      state.messages = [];
      state.receivedTotal = 0;
      state.seenIds.clear();
      state.seenIdQueue = [];
      state.readerStatuses.clear();
      removeKeepAliveFrame();
      overlay.clear();
    }

    syncOverlay();
  }

  function queueNavigationRefresh() {
    if (state.refreshQueued) {
      return;
    }

    state.refreshQueued = true;
    queueMicrotask(() => {
      state.refreshQueued = false;
      resetForNavigation();
    });
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    let shouldSync = false;
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue !== false;
      shouldSync = true;
    }

    if (changes[settingsApi.storageKey]) {
      state.overlaySettings = settingsApi.normalize(changes[settingsApi.storageKey].newValue);
      overlay.setSettings(state.overlaySettings);
      shouldSync = true;
    }

    if (shouldSync) {
      syncOverlay();
    }
  }

  function initialize() {
    chrome.storage.local.get({
      enabled: true,
      [settingsApi.storageKey]: settingsApi.defaults
    }, ({ enabled, overlaySettings }) => {
      state.enabled = enabled !== false;
      state.overlaySettings = settingsApi.normalize(overlaySettings);
      overlay.setSettings(state.overlaySettings);
      syncOverlay();
    });

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    document.addEventListener("fullscreenchange", syncOverlay);
    window.addEventListener("yt-navigate-start", queueNavigationRefresh);
    window.addEventListener("yt-navigate-finish", queueNavigationRefresh);
    window.addEventListener("yt-page-data-updated", queueNavigationRefresh);
    window.addEventListener("popstate", queueNavigationRefresh);
    chrome.storage.onChanged.addListener(handleStorageChange);
  }

  initialize();
})();
