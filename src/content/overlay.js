(() => {
  "use strict";

  const namespace = globalThis.__YT_LIVE_OVERLAY__ ??= {};
  const settingsApi = globalThis.__YT_LIVE_OVERLAY_SETTINGS__;

  class OverlayView {
    #root = null;
    #list = null;
    #jumpButton = null;
    #messages = [];
    #maxMessages;
    #settings;
    #interaction = null;
    #pendingSettings = null;
    #animationFrame = null;
    #fullscreenElement = null;
    #mountObserver = null;
    #onSettingsCommit;

    constructor(maxMessages = 100, callbacks = {}) {
      this.#maxMessages = maxMessages;
      this.#settings = settingsApi.normalize(settingsApi.defaults);
      this.#onSettingsCommit = callbacks.onSettingsCommit ?? (() => {});
    }

    mount(fullscreenElement) {
      if (!(fullscreenElement instanceof Element)) {
        this.unmount();
        return false;
      }

      if (!this.#root) {
        this.#create();
      }

      if (this.#fullscreenElement !== fullscreenElement) {
        this.#mountObserver?.disconnect();
        this.#fullscreenElement = fullscreenElement;
        this.#mountObserver = new MutationObserver(() => this.#ensureMounted());
        this.#mountObserver.observe(fullscreenElement, { childList: true });
      }

      this.#ensureMounted();
      return true;
    }

    unmount() {
      this.#mountObserver?.disconnect();
      this.#mountObserver = null;
      this.#fullscreenElement = null;
      this.#interaction = null;
      this.#pendingSettings = null;
      if (this.#animationFrame !== null) {
        cancelAnimationFrame(this.#animationFrame);
        this.#animationFrame = null;
      }
      this.#root?.classList.remove("yt-live-overlay--adjusting");
      this.#root?.remove();
    }

    replace(messages) {
      this.#messages = messages.slice(-this.#maxMessages);
      this.#render();
    }

    add(message) {
      this.#messages.push(message);

      if (this.#messages.length > this.#maxMessages) {
        this.#messages.splice(0, this.#messages.length - this.#maxMessages);
      }

      this.#render();
    }

    clear() {
      this.#messages = [];
      this.#render();
    }

    isMounted() {
      return Boolean(this.#root?.isConnected);
    }

    setSettings(settings) {
      this.#settings = settingsApi.normalize(settings);
      this.#applySettings();
    }

    #create() {
      this.#root = document.createElement("section");
      this.#root.id = "yt-live-overlay-root";
      this.#root.className = "yt-live-overlay";
      this.#root.setAttribute("aria-label", "YouTube Live chat overlay");
      this.#root.setAttribute("aria-live", "polite");
      this.#applySettings();

      this.#list = document.createElement("div");
      this.#list.className = "yt-live-overlay__list";
      this.#list.addEventListener("scroll", () => this.#updateJumpButton(), { passive: true });

      this.#jumpButton = document.createElement("button");
      this.#jumpButton.type = "button";
      this.#jumpButton.className = "yt-live-overlay__jump-latest";
      this.#jumpButton.setAttribute("aria-label", "最新のコメントへ戻る");
      this.#jumpButton.title = "最新のコメントへ戻る";
      this.#jumpButton.hidden = true;

      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrow.setAttribute("viewBox", "0 0 24 24");
      arrow.setAttribute("aria-hidden", "true");
      const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      arrowPath.setAttribute("d", "M6.7 9.3 12 14.6l5.3-5.3 1.4 1.4-6.7 6.7-6.7-6.7z");
      arrow.append(arrowPath);
      this.#jumpButton.append(arrow);
      this.#jumpButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#list.scrollTo({ top: this.#list.scrollHeight, behavior: "smooth" });
      });

      this.#root.append(this.#list, this.#jumpButton);

      document.addEventListener("pointerdown", (event) => this.#handlePointerDown(event), true);
      document.addEventListener("pointermove", (event) => this.#handlePointerMove(event), true);
      document.addEventListener("pointerup", (event) => this.#handlePointerEnd(event), true);
      document.addEventListener("pointercancel", (event) => this.#handlePointerEnd(event), true);
      document.addEventListener("wheel", (event) => this.#handleWheel(event), {
        capture: true,
        passive: false
      });
    }

    #applySettings() {
      if (!this.#root) {
        return;
      }

      this.#root.style.setProperty("--yt-live-overlay-x", `${this.#settings.x}%`);
      this.#root.style.setProperty("--yt-live-overlay-y", `${this.#settings.y}%`);
      this.#root.style.setProperty("--yt-live-overlay-width", `${this.#settings.width}px`);
      this.#root.style.setProperty("--yt-live-overlay-height", `${this.#settings.height}vh`);
      this.#root.style.setProperty("--yt-live-overlay-font-size", `${this.#settings.fontSize}px`);
      this.#root.style.setProperty(
        "--yt-live-overlay-background-opacity",
        String(this.#settings.backgroundOpacity / 100)
      );
      this.#root.style.setProperty("position", "fixed", "important");
      this.#root.style.setProperty("top", `${this.#settings.y}%`, "important");
      this.#root.style.setProperty("right", "auto", "important");
      this.#root.style.setProperty("bottom", "auto", "important");
      this.#root.style.setProperty("left", `${this.#settings.x}%`, "important");
      this.#root.style.setProperty(
        "width",
        `min(${this.#settings.width}px, calc(100vw - 24px))`,
        "important"
      );
      this.#root.style.setProperty(
        "height",
        `min(${this.#settings.height}vh, calc(100vh - 24px))`,
        "important"
      );
      this.#forceVisibleStyles();
    }

    #forceVisibleStyles() {
      if (!this.#root) {
        return;
      }

      const styles = {
        display: "flex",
        visibility: "visible",
        opacity: "1",
        "pointer-events": "none",
        "z-index": "2147483647",
        transform: "translate(-50%, -50%)",
        transition: "none",
        animation: "none",
        filter: "none",
        "content-visibility": "visible"
      };
      for (const [property, value] of Object.entries(styles)) {
        this.#root.style.setProperty(property, value, "important");
      }
    }

    #ensureMounted() {
      if (!this.#root || !this.#fullscreenElement ||
          document.fullscreenElement !== this.#fullscreenElement) {
        return;
      }

      if (this.#root.parentElement !== this.#fullscreenElement) {
        this.#fullscreenElement.append(this.#root);
      }
      this.#root.hidden = false;
      this.#forceVisibleStyles();
    }

    #handlePointerDown(event) {
      if (!this.#root?.isConnected || event.button !== 0 || !event.ctrlKey) {
        return;
      }

      const rect = this.#root.getBoundingClientRect();
      const isInside = event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!isInside) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.#interaction = {
        mode: event.shiftKey ? "resize" : "move",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        settings: { ...this.#settings }
      };
      this.#root.classList.add("yt-live-overlay--adjusting");
      try {
        this.#root.setPointerCapture(event.pointerId);
      } catch {
        // documentのcapture listenerでドラッグを継続する。
      }
    }

    #handleWheel(event) {
      if (!this.#root?.isConnected || !this.#list || this.#interaction) {
        return;
      }

      const rect = this.#root.getBoundingClientRect();
      const isInside = event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!isInside || this.#list.scrollHeight <= this.#list.clientHeight) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const lineHeight = Number.parseFloat(getComputedStyle(this.#list).lineHeight) || 20;
      const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? lineHeight
        : (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.#list.clientHeight : 1);
      this.#list.scrollTop += event.deltaY * multiplier;
    }

    #updateJumpButton() {
      if (!this.#list || !this.#jumpButton) {
        return;
      }

      const distanceFromBottom = this.#list.scrollHeight -
        this.#list.clientHeight - this.#list.scrollTop;
      const canScroll = this.#list.scrollHeight > this.#list.clientHeight + 1;
      this.#jumpButton.hidden = !canScroll || distanceFromBottom <= 24;
    }

    #handlePointerMove(event) {
      if (!this.#interaction || this.#interaction.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const deltaX = event.clientX - this.#interaction.startX;
      const deltaY = event.clientY - this.#interaction.startY;
      const start = this.#interaction.settings;
      const next = this.#interaction.mode === "move"
        ? {
            ...start,
            x: start.x + (deltaX / window.innerWidth) * 100,
            y: start.y + (deltaY / window.innerHeight) * 100
          }
        : {
            ...start,
            width: start.width + deltaX,
            height: start.height + (deltaY / window.innerHeight) * 100
          };

      this.#scheduleSettings(next);
    }

    #handlePointerEnd(event) {
      if (!this.#interaction || this.#interaction.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.#flushPendingSettings();
      this.#interaction = null;
      this.#root.classList.remove("yt-live-overlay--adjusting");
      if (this.#root.hasPointerCapture(event.pointerId)) {
        this.#root.releasePointerCapture(event.pointerId);
      }
      this.#onSettingsCommit({ ...this.#settings });
    }

    #scheduleSettings(settings) {
      this.#pendingSettings = settingsApi.normalize(settings);
      if (this.#animationFrame !== null) {
        return;
      }

      this.#animationFrame = requestAnimationFrame(() => {
        this.#animationFrame = null;
        const nextSettings = this.#pendingSettings;
        this.#pendingSettings = null;
        if (nextSettings) {
          this.setSettings(nextSettings);
        }
      });
    }

    #flushPendingSettings() {
      if (this.#animationFrame !== null) {
        cancelAnimationFrame(this.#animationFrame);
        this.#animationFrame = null;
      }

      const nextSettings = this.#pendingSettings;
      this.#pendingSettings = null;
      if (nextSettings) {
        this.setSettings(nextSettings);
      }
    }

    #render() {
      if (!this.#list) {
        return;
      }

      const distanceFromBottom = this.#list.scrollHeight -
        this.#list.clientHeight - this.#list.scrollTop;
      const shouldFollowLatest = distanceFromBottom <= 24;
      const listRect = this.#list.getBoundingClientRect();
      const anchor = Array.from(this.#list.children).find((child) => (
        child.getBoundingClientRect().bottom > listRect.top
      ));
      const anchorId = anchor?.dataset.messageId ?? null;
      const anchorOffset = anchor
        ? anchor.getBoundingClientRect().top - listRect.top
        : 0;
      const previousScrollTop = this.#list.scrollTop;

      const fragment = document.createDocumentFragment();

      for (const message of this.#messages) {
        const item = document.createElement("div");
        item.className = `yt-live-overlay__message yt-live-overlay__message--${message.kind}`;
        item.dataset.messageId = message.id;

        if (message.iconUrl) {
          const icon = document.createElement("img");
          icon.className = "yt-live-overlay__icon";
          icon.src = message.iconUrl;
          icon.alt = "";
          icon.referrerPolicy = "no-referrer";
          item.append(icon);
        }

        const text = document.createElement("div");
        text.className = "yt-live-overlay__text";

        const author = document.createElement("strong");
        author.className = "yt-live-overlay__author";
        author.textContent = `${message.author}: `;

        const body = document.createElement("span");
        body.className = "yt-live-overlay__body";
        for (const segment of message.segments) {
          if (segment.type === "text") {
            body.append(document.createTextNode(segment.text));
            continue;
          }

          if (segment.type === "emoji") {
            const emoji = document.createElement("img");
            emoji.className = "yt-live-overlay__emoji";
            emoji.src = segment.url;
            emoji.alt = segment.alt;
            emoji.referrerPolicy = "no-referrer";
            emoji.draggable = false;
            body.append(emoji);
          }
        }

        text.append(author, body);
        item.append(text);
        fragment.append(item);
      }

      this.#list.replaceChildren(fragment);
      if (shouldFollowLatest) {
        this.#list.scrollTop = this.#list.scrollHeight;
        this.#updateJumpButton();
        return;
      }

      const nextAnchor = anchorId
        ? Array.from(this.#list.children).find((child) => child.dataset.messageId === anchorId)
        : null;
      if (nextAnchor) {
        const nextListRect = this.#list.getBoundingClientRect();
        const nextAnchorOffset = nextAnchor.getBoundingClientRect().top - nextListRect.top;
        this.#list.scrollTop = previousScrollTop + nextAnchorOffset - anchorOffset;
      } else {
        this.#list.scrollTop = previousScrollTop;
      }
      this.#updateJumpButton();
    }
  }

  namespace.OverlayView = OverlayView;
})();
