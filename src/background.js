(() => {
  "use strict";

  const MESSAGE_SOURCE = "yt-live-chat-overlay";
  const FORWARDED_TYPES = new Set(["chat-message", "chat-reader-status"]);

  function isSupportedYouTubeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return (
        url.origin === "https://www.youtube.com" &&
        (url.pathname === "/live_chat" || url.pathname === "/watch")
      );
    } catch {
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (
      message?.source !== MESSAGE_SOURCE ||
      !FORWARDED_TYPES.has(message.type) ||
      !sender.tab?.id ||
      !isSupportedYouTubeUrl(sender.url)
    ) {
      return;
    }

    // iframeのDOM配置に依存せず、同じタブのトップフレームだけへ中継する。
    const forwardedMessage = {
      ...message,
      relay: {
        frameId: sender.frameId ?? 0,
        url: sender.url ?? ""
      }
    };

    if (!forwardedMessage.videoId) {
      try {
        const tabUrl = new URL(sender.tab.url);
        forwardedMessage.videoId = tabUrl.pathname === "/watch"
          ? tabUrl.searchParams.get("v")
          : null;
      } catch {
        forwardedMessage.videoId = null;
      }
    }

    chrome.tabs.sendMessage(sender.tab.id, forwardedMessage, { frameId: 0 }, () => {
      // SPA遷移中など、受信側が一時的に存在しない場合だけ無視する。
      void chrome.runtime.lastError;
    });
  });
})();
