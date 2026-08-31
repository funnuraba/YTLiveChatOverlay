(() => {
  "use strict";

  const enabledInput = document.querySelector("#enabled");
  const status = document.querySelector("#status");
  const diagnostics = document.querySelector("#diagnostics");

  function render(enabled) {
    enabledInput.checked = enabled;
    status.textContent = enabled ? "ON" : "OFF";
  }

  function renderDiagnostics(info) {
    if (!info) {
      diagnostics.textContent = "YouTubeタブを再読み込みしてから確認してください。";
      return;
    }

    const reader = info.readers.includes("observing")
      ? "監視中"
      : (info.readers.at(-1) ?? "未接続");
    diagnostics.textContent = [
      `v${info.version}`,
      `チャット: ${reader}`,
      `受信: ${info.receivedMessages}件`,
      `履歴: ${info.retainedMessages ?? 0}/${info.messageLimit ?? 100}件`,
      `全画面: ${info.fullscreen ? "はい" : "いいえ"}`,
      `Live判定: ${info.live ? "はい" : "いいえ"}`,
      `補助チャット: ${info.keepAlive ? "稼働" : "停止"}`,
      `Overlay: ${info.overlayMounted ? "表示中" : "非表示"}`,
      `全画面要素: ${info.fullscreenElement}`
    ].join("\n");
  }

  function refreshDiagnostics() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        renderDiagnostics(null);
        return;
      }

      chrome.tabs.sendMessage(
        tab.id,
        { source: "yt-live-chat-overlay", type: "get-diagnostics" },
        { frameId: 0 },
        (info) => {
          if (chrome.runtime.lastError) {
            renderDiagnostics(null);
            return;
          }
          renderDiagnostics(info);
        }
      );
    });
  }

  chrome.storage.local.get({ enabled: true }, (values) => {
    render(values.enabled !== false);
    refreshDiagnostics();
  });

  enabledInput.addEventListener("change", () => {
    const enabled = enabledInput.checked;
    render(enabled);
    chrome.storage.local.set({ enabled }, refreshDiagnostics);
  });

})();
