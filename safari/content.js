// safari/content.js - Sarashina 翻訳 Safari拡張機能 コンテンツスクリプト

(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const speechStatus = globalThis.SarashinaSpeechStatus;

  const POPUP_CONTAINER_ID = "sarashina-translator-container";
  const PAGE_BAR_CONTAINER_ID = "sarashina-page-bar-container";

  let selectionRequestId = 0;
  let selectionState = null;
  let selectionContainer;
  let selectionView = "translation";
  let unmountSelectionLoading;
  let explanationRequestId = 0;
  let selectionExplanation = { status: "idle", text: "", error: "" };
  let nuanceRequestId = 0;
  let selectionNuance = { status: "idle", text: "", error: "" };
  let selectionReplacement = { target: null, applied: false, busy: false, message: "", appliedText: "" };
  let selectionSpeech;

  let isPageTranslating = false;
  let isPageTranslated = false;
  let currentDirection = "en_to_ja";
  let translatedNodesList = [];
  let pageTranslationRequestId = 0;
  let pageBar;
  let unmountPageLoading;

  const COMMON_ICON_LIGATURES = new Set([
    "star", "mic", "bolt", "share", "add", "menu", "close", "search", "send",
    "refresh", "check", "edit", "delete", "help", "info", "warning", "error",
    "home", "settings", "tune", "favorite", "thumb_up", "thumb_down", "person",
    "group", "folder", "file", "download", "upload", "copy", "content_copy",
    "expand_more", "expand_less", "chevron_right", "chevron_left", "arrow_back",
    "arrow_forward", "arrow_upward", "arrow_downward", "more_vert", "more_horiz",
    "visibility", "visibility_off", "cloud", "cloud_off", "wifi", "wifi_off",
    "lock", "lock_open", "link", "code", "terminal", "play_arrow", "pause",
    "stop", "skip_next", "skip_previous", "compare_arrows", "open_in_new",
    "check_circle", "cancel", "done", "clear", "dashboard", "apps", "auto_awesome"
  ]);

  function containsJapanese(text) {
    return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text);
  }

  globalThis.SarashinaReading?.configure({ skipElement: isIconOrDecorativeElement });

  function startSpeechMeter(playback) {
    const { analyser, samples, requestId } = playback;
    function sample() {
      if (selectionSpeech !== playback || !playback.source) return;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const level = Math.min(1, Math.sqrt(energy / samples.length) * 3);
      speechStatus?.setLevel(requestId, level);
      playback.meterFrame = requestAnimationFrame(sample);
    }
    playback.meterFrame = requestAnimationFrame(sample);
  }

  function stopSpeechMeter(playback) {
    if (playback.meterFrame !== undefined) cancelAnimationFrame(playback.meterFrame);
    playback.meterFrame = undefined;
    speechStatus?.setLevel(playback.requestId, 0);
  }

  function closeSelectionSpeech(playback) {
    if (!playback || selectionSpeech !== playback) return;
    selectionSpeech = undefined;
    stopSpeechMeter(playback);
    speechStatus?.update(playback.requestId, "hidden");
    playback.source?.stop();
    void playback.context.close().catch(() => {});
  }

  async function prepareSelectionSpeech(requestId) {
    closeSelectionSpeech(selectionSpeech);
    const context = new AudioContext();
    const playback = { requestId, context, audioQueue: [], playing: false, final: false };
    selectionSpeech = playback;
    speechStatus?.update(requestId, "preparing", () => {
      if (selectionSpeech !== playback || playback.started) return;
      closeSelectionSpeech(playback);
      void ext.runtime.sendMessage({ action: "abort_selection_speech", requestId }).catch(() => {});
    });
    let timeout;
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(context.destination);
      playback.analyser = analyser;
      playback.samples = new Float32Array(analyser.fftSize);
      await Promise.race([
        context.resume(),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Safariが音声再生を許可しませんでした。")), 3000);
        })
      ]);
    } catch (error) {
      closeSelectionSpeech(playback);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function playSelectionSpeech(playback) {
    playback.playing = true;
    try {
      while (playback.audioQueue.length) {
        const { audio, caption } = playback.audioQueue.shift();
        const bytes = Uint8Array.from(atob(audio), char => char.charCodeAt(0));
        const buffer = await playback.context.decodeAudioData(bytes.buffer);
        if (selectionSpeech !== playback) return;

        const source = playback.context.createBufferSource();
        source.buffer = buffer;
        source.connect(playback.analyser);
        await new Promise(resolve => {
          source.onended = resolve;
          source.start();
          playback.source = source;
          if (!playback.started) {
            playback.started = true;
            speechStatus?.update(playback.requestId, "playing");
          }
          speechStatus?.showCaption(playback.requestId, caption);
          startSpeechMeter(playback);
        });
        playback.source = undefined;
        if (selectionSpeech !== playback) return;
        stopSpeechMeter(playback);
        source.disconnect();
      }
    } catch (error) {
      if (selectionSpeech === playback) console.warn("読み上げを再生できませんでした:", error.message);
      closeSelectionSpeech(playback);
    } finally {
      playback.playing = false;
      if (playback.final) closeSelectionSpeech(playback);
    }
  }

  // メッセージリスナー
  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ping") {
      sendResponse({ pong: true });
      return;
    }

    if (message.action === "prepare_selection_speech") {
      prepareSelectionSpeech(message.requestId)
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }

    if (message.action === "play_selection_speech") {
      if (selectionSpeech?.requestId !== message.requestId) {
        sendResponse({ success: false, error: "読み上げを行うページが変わりました。" });
        return;
      }
      selectionSpeech.audioQueue.push({ audio: message.audio, caption: message.caption });
      selectionSpeech.final = message.final;
      if (!selectionSpeech.playing) void playSelectionSpeech(selectionSpeech);
      sendResponse({ success: true });
      return;
    }

    if (message.action === "cancel_selection_speech") {
      if (selectionSpeech?.requestId === message.requestId) closeSelectionSpeech(selectionSpeech);
      sendResponse({ success: true });
      return;
    }

    const replacementModule = globalThis.SarashinaSelectionReplacement;
    if (message.action === "capture_selection") {
      sendResponse(replacementModule?.capture(message.sourceText) || {
        success: false, error: "拡張機能とこのページを再読み込みしてください。"
      });
      return;
    }
    if (message.action === "apply_selection_translation" || message.action === "restore_selection_translation") {
      const result = message.action === "apply_selection_translation"
        ? replacementModule?.replace(message.targetId, message.text)
        : replacementModule?.restore(message.targetId);
      sendResponse(result || { success: false, error: "選択範囲があるページを再読み込みしてください。" });
      return;
    }
    if (message.action === "release_selection_target") {
      replacementModule?.release(message.targetId);
      sendResponse({ success: true });
      return;
    }

    if (message.action === "translate_selection") {
      releaseSelectionTarget();
      selectionReplacement = {
        target: message.replacementTarget || null, applied: false, busy: false,
        message: message.replacementError || "", appliedText: ""
      };
      const sourceText = typeof message.sourceText === "string" ? message.sourceText.trim() : "";
      if (message.initialTask === "explain" && sourceText) {
        ++selectionRequestId;
        ++explanationRequestId;
        selectionExplanation = { status: "idle", text: "", error: "" };
        ++nuanceRequestId;
        selectionNuance = { status: "idle", text: "", error: "" };
        selectionView = "explanation";
        showSelectionBar({ status: "idle", sourceText, direction: "auto" });
        void explainSelection();
      } else {
        void translateSelection(sourceText, message.direction);
      }
      sendResponse({ success: true });
      return;
    }

    if (message.action === "start_selection_readings") {
      const reading = globalThis.SarashinaReading;
      if (!reading) {
        sendResponse({ success: false, error: "拡張機能と対象ページを再読み込みしてください。" });
      } else if (isPageTranslating) {
        sendResponse({ success: false, error: "ページの翻訳が終わってから、読みを表示してください。" });
      } else {
        sendResponse(reading.startSelection(message.sourceText));
      }
      return;
    }

    if (message.action === "start_page_readings" || message.action === "remove_page_readings") {
      const reading = globalThis.SarashinaReading;
      if (!reading) {
        sendResponse({ success: false, error: "拡張機能と対象ページを再読み込みしてください。" });
      } else if (message.action === "remove_page_readings") {
        reading.remove();
        sendResponse({ success: true });
      } else if (isPageTranslating) {
        sendResponse({ success: false, error: "ページの翻訳が終わってから、読みを表示してください。" });
      } else {
        void reading.start();
        sendResponse({ success: true });
      }
      return;
    }

    if (message.action === "start_page_translation") {
      const dir = message.direction || "en_to_ja";
      startFullPageTranslation(dir);
    }
  });

  // 1. 選択テキスト翻訳
  async function translateSelection(sourceText, direction = "auto") {
    const text = sourceText.trim();
    if (!text) return;

    selectionView = "translation";
    const requestId = ++selectionRequestId;
    ++explanationRequestId;
    selectionExplanation = { status: "idle", text: "", error: "" };
    ++nuanceRequestId;
    selectionNuance = { status: "idle", text: "", error: "" };
    showSelectionBar({ status: "loading", sourceText: text, direction });
    try {
      const response = await ext.runtime.sendMessage({ action: "translate", text, direction });
      if (requestId !== selectionRequestId) return;
      if (!response?.success || !response.data?.translatedText) {
        throw new Error(response?.error || "翻訳結果を取得できませんでした。再試行してください。");
      }
      showSelectionBar({
        status: "success", sourceText: text, direction,
        translatedText: response.data.translatedText, model: response.data.model
      });
    } catch (error) {
      if (requestId !== selectionRequestId) return;
      showSelectionBar({
        status: "error", sourceText: text, direction,
        errorMessage: error.message || "翻訳処理中にエラーが発生しました。"
      });
    }
  }

  async function explainSelection() {
    if (!selectionState || selectionState.status === "loading" || selectionReplacement.busy
        || selectionExplanation.status === "loading" || selectionNuance.status === "loading") return;
    const selectionId = selectionRequestId;
    const requestId = ++explanationRequestId;
    const text = selectionState.sourceText;
    const translatedText = selectionState.status === "success" ? selectionState.translatedText : undefined;
    selectionView = "explanation";
    selectionExplanation = { status: "loading", text: "", error: "" };
    showSelectionBar(selectionState);
    try {
      const response = await ext.runtime.sendMessage({
        action: "explain", text, ...(translatedText ? { translatedText } : {})
      });
      if (requestId !== explanationRequestId || selectionId !== selectionRequestId || !selectionState) return;
      if (!response?.success || typeof response.data?.explanationText !== "string" || !response.data.explanationText.trim()) {
        throw new Error(response?.error || "解説を取得できませんでした。再試行してください。");
      }
      selectionExplanation = { status: "success", text: response.data.explanationText, error: "" };
    } catch (error) {
      if (requestId !== explanationRequestId || selectionId !== selectionRequestId || !selectionState) return;
      selectionExplanation = { status: "error", text: "", error: error.message || "解説の作成に失敗しました。" };
    }
    if (requestId === explanationRequestId && selectionId === selectionRequestId && selectionState) {
      showSelectionBar(selectionState);
    }
  }

  async function explainTranslationNuance() {
    if (!selectionState || selectionState.status !== "success" || selectionReplacement.busy
        || selectionExplanation.status === "loading" || selectionNuance.status === "loading") return;
    const selectionId = selectionRequestId;
    const requestId = ++nuanceRequestId;
    const { sourceText: text, translatedText } = selectionState;
    selectionView = "nuance";
    selectionNuance = { status: "loading", text: "", error: "" };
    showSelectionBar(selectionState);
    try {
      const response = await ext.runtime.sendMessage({
        action: "explain_translation_nuance", text, translatedText
      });
      if (requestId !== nuanceRequestId || selectionId !== selectionRequestId || !selectionState) return;
      if (!response?.success || typeof response.data?.nuanceText !== "string" || !response.data.nuanceText.trim()) {
        throw new Error(response?.error || "訳文のニュアンスを取得できませんでした。再試行してください。");
      }
      selectionNuance = { status: "success", text: response.data.nuanceText, error: "" };
    } catch (error) {
      if (requestId !== nuanceRequestId || selectionId !== selectionRequestId || !selectionState) return;
      selectionNuance = { status: "error", text: "", error: error.message || "訳文のニュアンスの確認に失敗しました。" };
    }
    if (requestId === nuanceRequestId && selectionId === selectionRequestId && selectionState) {
      showSelectionBar(selectionState);
    }
  }

  function releaseSelectionTarget() {
    if (selectionReplacement.target) {
      // 保持したノード参照だけを解放し、置き換えた表示はそのまま残す。
      void ext.runtime.sendMessage({
        action: "release_selection", target: selectionReplacement.target
      }).catch(() => {});
    }
  }

  async function updateSelectionReplacement(restore) {
    const state = selectionReplacement;
    if (!state.target || state.busy || !selectionState) return;
    const requestId = selectionRequestId;
    const translatedText = selectionState.translatedText;
    state.busy = true;
    state.message = "";
    showSelectionBar(selectionState);
    try {
      const response = await ext.runtime.sendMessage({
        action: restore ? "restore_selection" : "replace_selection",
        target: state.target, text: translatedText
      });
      if (!response?.success) throw new Error(response?.error || "選択部分を更新できませんでした。文章を選び直してください。");
      state.applied = !restore;
      state.appliedText = restore ? "" : translatedText;
      state.message = restore ? "原文に戻しました。" : "選択部分を訳文に置き換えました。";
    } catch (error) {
      state.message = error.message || "選択部分を更新できませんでした。";
    } finally {
      state.busy = false;
      if (state === selectionReplacement && requestId === selectionRequestId && selectionState) {
        showSelectionBar(selectionState);
      }
    }
  }

  function setSelectionActions(open, focus = true) {
    const shadow = selectionContainer.shadowRoot;
    const menu = shadow.getElementById("sarashina-selection-actions");
    if (!menu) return;
    menu.hidden = !open;
    const button = shadow.querySelector('[data-action="menu"]');
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      const { top, bottom } = button.getBoundingClientRect();
      const above = top - 8;
      const below = document.documentElement.clientHeight - bottom - 8;
      const opensUp = menu.scrollHeight > below && above > below;
      menu.toggleAttribute("data-opens-up", opensUp);
      menu.style.maxHeight = `${Math.max(0, opensUp ? above : below)}px`;
    }
    if (focus) (open ? menu.querySelector("button:enabled") : button)?.focus({ preventScroll: true });
  }

  function onSelectionPointerdown(event) {
    if (!event.composedPath().includes(selectionContainer)) setSelectionActions(false, false);
  }

  function onSelectionKeydown(event) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const menu = selectionContainer.shadowRoot.getElementById("sarashina-selection-actions");
    if (menu && !menu.hidden) setSelectionActions(false);
    else removeSelectionBar();
  }

  function showSelectionView(view) {
    selectionView = view;
    showSelectionBar(selectionState);
  }

  function onSelectionAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const data = selectionState;
    switch (action) {
      case "close":
        removeSelectionBar();
        break;
      case "menu":
        setSelectionActions(button.getAttribute("aria-expanded") !== "true");
        break;
      case "back":
        showSelectionView(data.status === "idle" ? "explanation" : "translation");
        break;
      case "source":
      case "direction":
        showSelectionView(action);
        break;
      case "explanation":
        if (selectionExplanation.status === "idle") void explainSelection();
        else showSelectionView("explanation");
        break;
      case "nuance":
        if (selectionNuance.status === "idle") void explainTranslationNuance();
        else showSelectionView("nuance");
        break;
      case "retry-explanation":
        void explainSelection();
        break;
      case "retry-nuance":
        void explainTranslationNuance();
        break;
      case "retry-translation":
        void translateSelection(data.sourceText, data.direction);
        break;
      case "replace":
        setSelectionActions(false, false);
        void updateSelectionReplacement(false);
        break;
      case "restore":
        void updateSelectionReplacement(true);
        break;
      case "copy":
        void copySelectionTranslation(button, data.translatedText);
        break;
    }
  }

  async function copySelectionTranslation(button, text) {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "コピー済み";
      button.classList.add("copied");
      setTimeout(() => {
        button.textContent = "コピー";
        button.classList.remove("copied");
      }, 1500);
    } catch (error) {
      console.error("コピー失敗:", error);
    }
  }

  function showSelectionBar(data) {
    selectionState = data;
    const shouldFocus = !selectionContainer?.isConnected || document.activeElement === selectionContainer;
    const feedback = globalThis.SarashinaFeedback;
    if (!selectionContainer?.isConnected) {
      document.getElementById(POPUP_CONTAINER_ID)?.remove();
      selectionContainer = document.createElement("div");
      selectionContainer.id = POPUP_CONTAINER_ID;
      selectionContainer.lang = "ja";
      const shadow = selectionContainer.attachShadow({ mode: "open" });
      const styles = getSelectionBarStyles();
      if (feedback) feedback.installStyles(shadow, styles);
      else {
        const style = document.createElement("style");
        style.textContent = styles;
        shadow.append(style);
      }
      const wrapper = document.createElement("div");
      wrapper.id = "sarashina-selection-wrapper";
      wrapper.onclick = onSelectionAction;
      shadow.append(wrapper);
      if (feedback) feedback.placeBar(selectionContainer);
      else document.documentElement.appendChild(selectionContainer);
      document.addEventListener("keydown", onSelectionKeydown);
      document.addEventListener("pointerdown", onSelectionPointerdown, true);
    }

    const shadow = selectionContainer.shadowRoot;
    const wrapper = shadow.getElementById("sarashina-selection-wrapper");
    const previousView = wrapper.firstElementChild?.dataset.view;
    const focusedAction = shadow.activeElement?.dataset.action;
    const scroll = wrapper.querySelector(".sarashina-body")?.scrollTop ?? 0;
    unmountSelectionLoading?.();
    wrapper.innerHTML = renderSelectionBar(data);
    const body = wrapper.querySelector(".sarashina-body");
    if (previousView === selectionView) body.scrollTop = scroll;
    const loading = wrapper.querySelector(".sarashina-orb");
    unmountSelectionLoading = loading && feedback ? feedback.mountLoading(loading, { beam: true }) : undefined;

    const form = wrapper.querySelector("form");
    if (form) form.onsubmit = event => {
      event.preventDefault();
      if (selectionActionPending()) return;
      void translateSelection(data.sourceText, form.elements.direction.value);
    };
    if (shouldFocus) {
      const previous = focusedAction && wrapper.querySelector(`[data-action="${CSS.escape(focusedAction)}"]:enabled`);
      const usable = previous && !previous.closest("[hidden]") ? previous : null;
      const focus = usable || wrapper.querySelector('[data-action="back"], [data-action="menu"]')
        || wrapper.querySelector('[data-action="close"]');
      (form?.elements.direction || focus).focus({ preventScroll: true });
    }
    return true;
  }

  function removeSelectionBar() {
    ++explanationRequestId;
    selectionExplanation = { status: "idle", text: "", error: "" };
    ++nuanceRequestId;
    selectionNuance = { status: "idle", text: "", error: "" };
    releaseSelectionTarget();
    selectionReplacement = { target: null, applied: false, busy: false, message: "", appliedText: "" };
    ++selectionRequestId;
    selectionState = null;
    selectionView = "translation";
    unmountSelectionLoading?.();
    unmountSelectionLoading = undefined;
    document.removeEventListener("keydown", onSelectionKeydown);
    document.removeEventListener("pointerdown", onSelectionPointerdown, true);
    selectionContainer?.remove();
    selectionContainer = undefined;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function selectionActionPending() {
    return selectionState.status === "loading" || selectionReplacement.busy
      || selectionExplanation.status === "loading" || selectionNuance.status === "loading";
  }

  function renderSelectionBar(data) {
    const translated = data.status === "success";
    const translationView = selectionView === "translation";
    const busy = selectionActionPending();
    const closeLabel = data.status === "loading" ? "翻訳を中止" : "閉じる";
    const count = text => `<span class="sarashina-character-count">${Array.from(text).length.toLocaleString("ja-JP")}文字</span>`;
    const loading = text => `<div class="sarashina-loading" role="status"><span class="sarashina-orb" aria-hidden="true"></span>${text}</div>`;
    const failure = (error, action) => `
      <p class="sarashina-error-message" role="alert">${escapeHtml(error)}</p>
      <button type="button" data-action="${action}" ${busy ? "disabled" : ""}>再試行</button>
    `;
    const waiting = translationView && data.status === "loading";
    let title = "";
    let content = "";
    if (translationView) {
      if (waiting) content = loading("翻訳中");
      else if (translated) {
        title = `訳文 ${count(data.translatedText)}`;
        content = `<div class="sarashina-translated-text" role="status">${escapeHtml(data.translatedText)}</div>`;
      } else {
        title = "翻訳";
        content = failure(data.errorMessage, "retry-translation");
      }
    } else if (selectionView === "source") {
      title = `原文 ${count(data.sourceText)}`;
      content = `<div class="sarashina-view-text">${escapeHtml(data.sourceText)}</div>
        ${data.model ? `<div class="sarashina-model">翻訳モデル ${escapeHtml(data.model)}</div>` : ""}`;
    } else if (selectionView === "direction") {
      title = "翻訳方向";
      content = `
        <form class="sarashina-direction-form">
          <select name="direction" aria-label="翻訳方向">
            <option value="auto" ${data.direction === "auto" ? "selected" : ""}>自動判定</option>
            <option value="en_to_ja" ${data.direction === "en_to_ja" ? "selected" : ""}>英語 → 日本語</option>
            <option value="ja_to_en" ${data.direction === "ja_to_en" ? "selected" : ""}>日本語 → 英語</option>
            ${data.direction === "multilingual_to_ja" ? '<option value="multilingual_to_ja" selected>多言語 → 日本語</option>' : ""}
          </select>
          <button type="submit" ${busy ? "disabled" : ""}>${data.status === "idle" ? "翻訳" : "再翻訳"}</button>
        </form>
      `;
    } else {
      const isExplanation = selectionView === "explanation";
      const detail = isExplanation ? selectionExplanation : selectionNuance;
      title = isExplanation ? "解説" : "訳文のニュアンス";
      if (detail.status === "loading" || detail.status === "idle") {
        content = loading(isExplanation ? "解説を作成中" : "ニュアンスを確認中");
      } else if (detail.status === "error") {
        content = failure(detail.error, isExplanation ? "retry-explanation" : "retry-nuance");
      } else {
        content = `<div class="sarashina-view-text" role="status">${escapeHtml(detail.text)}</div>`;
      }
    }

    return `
      <section class="sarashina-selection-bar${waiting ? " sarashina-waiting" : ""}" data-view="${selectionView}"
          role="dialog" aria-label="選択テキストの翻訳">
        <div class="sarashina-toolbar">
          ${!translationView && (data.status !== "idle" || selectionView !== "explanation")
            ? `<button type="button" data-action="back">← ${data.status === "idle" ? "解説" : translated ? "訳文" : "翻訳"}</button>` : ""}
          ${title ? `<span class="sarashina-view-title">${title}</span>` : ""}
          ${translationView && translated ? '<button type="button" class="sarashina-copy-btn" data-action="copy">コピー</button>' : ""}
          ${selectionReplacement.applied ? `<button type="button" data-action="restore" ${busy ? "disabled" : ""}>元に戻す</button>` : ""}
          ${data.status === "idle" && selectionView === "explanation"
            ? '<button type="button" data-action="source">原文</button>' : ""}
          ${data.status === "idle" && selectionView !== "direction"
            ? `<button type="button" data-action="direction" ${busy ? "disabled" : ""}>翻訳</button>` : ""}
          ${translationView && !waiting ? `
            <div class="sarashina-menu-anchor">
              <button type="button" class="sarashina-icon-btn" data-action="menu" aria-label="その他の操作"
                  aria-expanded="false" aria-controls="sarashina-selection-actions" title="その他の操作">…</button>
              <div id="sarashina-selection-actions" role="group" aria-label="その他の操作" data-sarashina-no-drag hidden>
                <button type="button" data-action="source">原文</button>
                <button type="button" data-action="explanation" ${busy && selectionExplanation.status === "idle" ? "disabled" : ""}>解説</button>
                ${translated ? `<button type="button" data-action="nuance" ${busy && selectionNuance.status === "idle" ? "disabled" : ""}>訳文のニュアンス</button>` : ""}
                <button type="button" data-action="direction" ${busy ? "disabled" : ""}>翻訳方向</button>
                ${translated && selectionReplacement.target ? `
                  <button type="button" data-action="replace" ${busy || selectionReplacement.appliedText === data.translatedText ? "disabled" : ""}>
                    ${selectionReplacement.applied ? "訳文を更新" : "原文を訳文に置き換える"}
                  </button>
                ` : ""}
              </div>
            </div>
          ` : ""}
          <button type="button" class="sarashina-icon-btn" data-action="close" aria-label="${closeLabel}" title="${closeLabel}">×</button>
        </div>
        <div class="sarashina-body" tabindex="0" ${waiting ? "" : "data-sarashina-no-drag"}>${content}</div>
        ${selectionReplacement.message ? `<div class="sarashina-replacement-message" role="status">${escapeHtml(selectionReplacement.message)}</div>` : ""}
      </section>
    `;
  }

  function getSelectionBarStyles() {
    return `
      :host {
        all: initial;
        position: fixed !important;
        inset: 24px 0 auto !important;
        width: min(450px, calc(100% - 32px)) !important;
        min-width: 0 !important;
        max-width: 450px !important;
        margin: 0 auto !important;
        display: block;
        pointer-events: none;
        z-index: 2147483647;
      }
      :host([data-sarashina-stacked]) {
        position: relative !important;
        inset: auto !important;
        width: 100% !important;
        margin: 0 !important;
      }
      .sarashina-selection-bar {
        position: relative;
        isolation: isolate;
        pointer-events: auto;
        box-sizing: border-box;
        width: 100%;
        max-width: 450px;
        background: #202020;
        color: #fff;
        color-scheme: dark;
        font: 15px/1.55 system-ui, sans-serif;
        border-radius: 16px;
        box-shadow: 0 8px 28px #0006;
      }
      .sarashina-toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 10px 4px 16px;
        touch-action: none;
      }
      .sarashina-view-title {
        flex: 1;
        min-width: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .sarashina-waiting .sarashina-toolbar { position: absolute; z-index: 1; top: 6px; right: 6px; padding: 0; }
      .sarashina-body {
        max-height: min(38vh, 300px);
        overflow: auto;
        padding: 4px 16px 14px;
        overscroll-behavior: contain;
      }
      .sarashina-waiting .sarashina-body { padding: 0 44px; touch-action: none; }
      .sarashina-body[data-sarashina-no-drag] { cursor: auto; }
      .sarashina-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 84px;
        gap: 12px;
        font-size: 18px;
        font-weight: 700;
      }
      .sarashina-orb { display: flex; }
      .sarashina-character-count, .sarashina-model, .sarashina-replacement-message { color: #bec8d2; font-size: 12px; }
      .sarashina-model { margin-top: 8px; }
      .sarashina-replacement-message { padding: 0 16px 10px; overflow-wrap: anywhere; }
      .sarashina-translated-text, .sarashina-view-text { white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
      .sarashina-translated-text { font-size: 16px; line-height: 1.55; }
      .sarashina-error-message {
        margin: 0 0 8px;
        padding: 8px 10px;
        border-radius: 8px;
        background: #452c2e;
        color: #ffdddd;
        overflow-wrap: anywhere;
      }
      .sarashina-direction-form { display: flex; gap: 8px; }
      .sarashina-direction-form select { min-width: 0; flex: 1; }
      .sarashina-menu-anchor { position: relative; z-index: 2; }
      #sarashina-selection-actions {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        display: grid;
        gap: 2px;
        min-width: 180px;
        box-sizing: border-box;
        overflow-y: auto;
        padding: 5px;
        border: 1px solid #686d73;
        border-radius: 10px;
        background: #282a2d;
        box-shadow: 0 8px 24px #0008;
      }
      #sarashina-selection-actions[data-opens-up] { top: auto; bottom: calc(100% + 4px); }
      #sarashina-selection-actions[hidden] { display: none; }
      #sarashina-selection-actions button { text-align: left; border-color: transparent; background: transparent; }
      button, select {
        min-height: 34px;
        box-sizing: border-box;
        padding: 5px 8px;
        border: 1px solid #686d73;
        border-radius: 8px;
        background: #303338;
        color: #fff;
        font: 600 13px/1.3 system-ui, sans-serif;
        cursor: pointer;
      }
      button:enabled:hover, select:enabled:hover, #sarashina-selection-actions button:enabled:hover { background: #41454a; }
      button:disabled { opacity: .55; cursor: default; }
      button:focus-visible, select:focus-visible, .sarashina-body:focus-visible {
        outline: 2px solid #c1e4ff;
        outline-offset: -2px;
      }
      .sarashina-copy-btn, .sarashina-copy-btn:enabled:hover {
        background: #c1e4ff;
        color: #18252f;
        border-color: transparent;
      }
      .sarashina-copy-btn.copied { background: #bcf1da; }
      .sarashina-icon-btn {
        width: 36px;
        height: 36px;
        padding: 0;
        background: transparent;
        border: 0;
        font-size: 22px;
      }
    `;
  }

  // 2. ページ全体翻訳機能
  async function startFullPageTranslation(direction = "en_to_ja") {
    if (isPageTranslating) return;
    globalThis.SarashinaReading?.remove();

    if (isPageTranslated) {
      restoreOriginalPage(false);
    }

    currentDirection = direction;
    isPageTranslating = true;
    const requestId = ++pageTranslationRequestId;

    const isMultilingual = direction === "multilingual_to_ja";
    showPageBar("ページを翻訳中", "loading");

    const targetNodes = collectTranslatableTextNodes(document.body, direction);

    if (targetNodes.length === 0) {
      const msg = direction === "en_to_ja"
        ? "翻訳対象の英語テキストが見つかりませんでした（既に日本語です）。"
        : "翻訳対象の日本語テキストが見つかりませんでした。";
      showPageBar(isMultilingual ? "翻訳対象のテキストが見つかりませんでした。" : msg, "completed");
      isPageTranslating = false;
      return;
    }

    const chunks = [];
    let currentChunk = [];
    let currentLen = 0;

    for (let i = 0; i < targetNodes.length; i++) {
      const node = targetNodes[i];
      const text = node.nodeValue.trim();
      if (!text) continue;

      const line = `[${currentChunk.length + 1}] ${text}`;
      if (currentLen + line.length > 2000 && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLen = 0;
      }

      currentChunk.push({ node, text });
      currentLen += line.length + 1;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    translatedNodesList = [];
    let completedChunks = 0;
    const totalChunks = chunks.length;

    try {
      for (const chunk of chunks) {
        showPageBar(`ページを翻訳中 · ${completedChunks}/${totalChunks}`, "loading");

        const indexedLines = chunk.map((item, idx) => `[${idx + 1}] ${item.text}`).join("\n");

        const response = await ext.runtime.sendMessage({
          action: "translate",
          text: indexedLines,
          direction,
          ...(isMultilingual ? { preserveLineNumbers: true } : {})
        });

        if (requestId !== pageTranslationRequestId) return;
        if (response?.success === false && response.errorCode === "API_KEY_REQUIRED") {
          restoreOriginalPage(false);
          showPageBar("APIキーを設定してください", "settings");
          return;
        }

        if (!response || !response.success) {
          throw new Error(response?.error || "翻訳リクエストに失敗しました。");
        }

        const translatedText = response.data.translatedText;
        const parsedMap = parseIndexedTranslations(translatedText);

        for (let idx = 0; idx < chunk.length; idx++) {
          const item = chunk[idx];
          const key = idx + 1;
          const translatedVal = parsedMap[key];

          const originalValue = item.node.nodeValue;
          if (translatedVal && translatedVal !== item.text && item.node.isConnected && originalValue.trim() === item.text) {
            const leadingSpaces = originalValue.match(/^\s*/)[0];
            const trailingSpaces = originalValue.match(/\s*$/)[0];
            const translatedValue = leadingSpaces + translatedVal + trailingSpaces;
            translatedNodesList.push({ node: item.node, originalValue, translatedValue });
            item.node.nodeValue = translatedValue;
          }
        }

        completedChunks++;
      }

      isPageTranslated = translatedNodesList.length > 0;
      const language = direction === "ja_to_en" ? "英語" : "日本語";
      showPageBar(isPageTranslated ? `${language}で表示中` : "書き換える文章が見つかりませんでした", "completed");
    } catch (err) {
      if (requestId !== pageTranslationRequestId) return;
      restoreOriginalPage(false);
      showPageBar(`翻訳できませんでした。 ${err.message}`, "error");
    } finally {
      if (requestId === pageTranslationRequestId) isPageTranslating = false;
    }
  }

  function parseIndexedTranslations(raw) {
    const map = {};
    const regex = /(?:^|\n)\s*\[(\d+)\]\s*([\s\S]*?)(?=(?:\n\s*\[\d+\])|$)/g;
    let match;
    let count = 0;

    while ((match = regex.exec(raw)) !== null) {
      const id = parseInt(match[1], 10);
      const text = match[2].trim();
      if (!isNaN(id) && text) {
        map[id] = text;
        count++;
      }
    }

    if (count === 0) {
      const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l);
      for (let i = 0; i < lines.length; i++) {
        map[i + 1] = lines[i].replace(/^\[\d+\]\s*/, "");
      }
    }

    return map;
  }

  function restoreOriginalPage(updateBar = true) {
    globalThis.SarashinaReading?.remove();
    for (const { node, originalValue, translatedValue } of translatedNodesList) {
      if (node.isConnected && node.nodeValue === translatedValue) node.nodeValue = originalValue;
    }

    translatedNodesList = [];
    isPageTranslated = false;
    if (updateBar) {
      showPageBar("原文に復元しました。", "restored");
    }
  }

  function isIconOrDecorativeElement(element) {
    let curr = element;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      const tag = curr.tagName.toUpperCase();

      if (tag === "MAT-ICON" || tag === "MWC-ICON" || tag === "ICON") return true;
      if (curr.getAttribute("aria-hidden") === "true") return true;

      const cls = (typeof curr.className === "string" ? curr.className : "").toLowerCase();
      if (
        cls.includes("material-icons") ||
        cls.includes("material-symbols") ||
        cls.includes("google-symbols") ||
        cls.includes("fa-") ||
        cls.includes("fa_") ||
        cls.includes("glyphicon") ||
        cls.includes("feather-") ||
        cls.includes("tabler-")
      ) {
        return true;
      }

      try {
        const font = window.getComputedStyle(curr).fontFamily.toLowerCase();
        if (
          font.includes("icon") ||
          font.includes("symbol") ||
          font.includes("material") ||
          font.includes("font awesome") ||
          font.includes("glyph")
        ) {
          return true;
        }
      } catch (e) {}

      curr = curr.parentElement;
    }
    return false;
  }

  function isIconLigatureText(text) {
    const trimmed = text.trim().toLowerCase();

    if (/^[a-z]+(_[a-z0-9]+)+$/.test(trimmed)) {
      return true;
    }

    if (COMMON_ICON_LIGATURES.has(trimmed)) {
      return true;
    }

    return false;
  }

  function collectTranslatableTextNodes(root, direction) {
    const nodes = [];
    const ignoreTags = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE",
      "SVG", "CANVAS", "IFRAME", "SELECT", "AUDIO", "VIDEO", "RT", "RP"
    ]);

    function walk(node) {
      if (!node) return;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toUpperCase();
        if (ignoreTags.has(tagName)) return;
        if (node.id === POPUP_CONTAINER_ID || node.id === PAGE_BAR_CONTAINER_ID) return;
        if (node.getAttribute && node.getAttribute("contenteditable") === "true") return;

        if (isIconOrDecorativeElement(node)) {
          return;
        }

        if (node.offsetParent === null && tagName !== "BODY" && tagName !== "HTML") {
          try {
            const style = window.getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden") {
              return;
            }
          } catch (e) {}
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
          walk(child);
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue.trim();
        if (text.length >= 1 && /\p{L}/u.test(text)) {
          if (isIconLigatureText(text)) {
            return;
          }

          if (direction === "multilingual_to_ja") {
            nodes.push(node);
            return;
          }

          const hasJa = containsJapanese(text);

          if (direction === "en_to_ja") {
            if (!hasJa) {
              nodes.push(node);
            }
          } else {
            if (hasJa) {
              nodes.push(node);
            }
          }
        }
      }
    }

    walk(root);
    return nodes;
  }

  function showPageBar(message, status) {
    if (!pageBar?.isConnected) {
      document.getElementById(PAGE_BAR_CONTAINER_ID)?.remove();
      const container = document.createElement("div");
      pageBar = container;
      container.id = PAGE_BAR_CONTAINER_ID;
      container.lang = "ja";
      const shadow = container.attachShadow({ mode: "open" });
      const feedback = globalThis.SarashinaFeedback;
      const styles = getPageBarStyles();
      if (feedback) feedback.installStyles(shadow, styles);
      else {
        const style = document.createElement("style");
        style.textContent = styles;
        shadow.append(style);
      }
      const panel = document.createElement("div");
      panel.className = "sarashina-page-bar";
      shadow.append(panel);
      if (feedback) feedback.placeBar(container);
      else document.documentElement.appendChild(container);
    }

    const container = pageBar;
    const panel = container.shadowRoot.querySelector(".sarashina-page-bar");
    if (status === "loading" && panel.dataset.status === status) {
      panel.querySelector("[role=status]").textContent = message;
      return;
    }
    unmountPageLoading?.();
    unmountPageLoading = undefined;
    panel.dataset.status = status;
    const loading = status === "loading";
    const closeLabel = loading ? "ページ翻訳を中止" : "バーを閉じる";
    panel.innerHTML = `
      <div class="sarashina-bar-heading">
        ${loading ? '<span class="sarashina-bar-motion" aria-hidden="true"></span>' : ""}
        <span role="status" class="sarashina-bar-msg">${escapeHtml(message)}</span>
      </div>
      <button type="button" class="sarashina-bar-close" aria-label="${closeLabel}" title="${closeLabel}">×</button>
      ${loading ? "" : `
        <div class="sarashina-bar-actions">
          ${isPageTranslated ? '<button type="button" id="sarashina-restore-btn">原文に戻す</button>' : ""}
          ${status === "settings" ? '<button type="button" id="sarashina-open-settings-btn">設定を開く</button>' : `
            <select id="sarashina-bar-dir-select" aria-label="翻訳方向">
              <option value="en_to_ja">英語 → 日本語</option>
              <option value="ja_to_en">日本語 → 英語</option>
              <option value="multilingual_to_ja">多言語 → 日本語</option>
            </select>
            <button type="button" id="sarashina-switch-dir-btn">${status === "error" ? "再試行" : "翻訳実行"}</button>
          `}
        </div>
      `}
    `;

    const select = panel.querySelector("#sarashina-bar-dir-select");
    if (select) {
      select.value = currentDirection;
      panel.querySelector("#sarashina-switch-dir-btn").onclick = () => {
        void startFullPageTranslation(select.value);
      };
    }
    const restore = panel.querySelector("#sarashina-restore-btn");
    if (restore) restore.onclick = () => restoreOriginalPage();
    const settings = panel.querySelector("#sarashina-open-settings-btn");
    if (settings) settings.onclick = async () => {
      try {
        await ext.runtime.sendMessage({ action: "open_options" });
      } catch {
        // 拡張機能を再読み込みすると、古いタブからは設定画面を開けない。
      }
    };
    panel.querySelector(".sarashina-bar-close").onclick = () => {
      if (loading) {
        ++pageTranslationRequestId;
        isPageTranslating = false;
        restoreOriginalPage(false);
      }
      unmountPageLoading?.();
      unmountPageLoading = undefined;
      container.remove();
      pageBar = undefined;
    };
    if (loading) {
      unmountPageLoading = globalThis.SarashinaFeedback?.mountLoading(
        panel.querySelector(".sarashina-bar-motion"), { beam: true }
      );
    }
  }

  function getPageBarStyles() {
    return `
      :host {
        all: initial;
        position: fixed;
        inset: 24px 0 auto;
        width: min(450px, calc(100% - 32px));
        margin-inline: auto;
        display: block;
        z-index: 2147483647;
        pointer-events: none;
      }
      :host([data-sarashina-stacked]) { position: static; width: 100%; }
      .sarashina-page-bar {
        position: relative;
        isolation: isolate;
        box-sizing: border-box;
        padding: 12px 44px 12px 16px;
        border-radius: 16px;
        background: #202020;
        color: #fff;
        box-shadow: 0 8px 28px #0006;
        font: 600 15px/1.4 system-ui, sans-serif;
        color-scheme: dark;
        pointer-events: auto;
      }
      .sarashina-page-bar { touch-action: none; }
      [data-status=loading] { padding-block: 8px; }
      .sarashina-bar-heading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        min-height: 32px;
        text-align: center;
        overflow-wrap: anywhere;
      }
      [data-status=loading] .sarashina-bar-heading { min-height: 68px; font-size: 18px; }
      .sarashina-bar-motion { display: flex; }
      .sarashina-bar-msg { text-wrap: balance; }
      .sarashina-bar-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        margin-top: 6px;
      }
      button, select {
        min-height: 34px;
        box-sizing: border-box;
        padding: 5px 9px;
        border: 1px solid #686d73;
        border-radius: 8px;
        background: #303338;
        color: #fff;
        font: 600 13px/1.3 system-ui, sans-serif;
        cursor: pointer;
      }
      button:hover, select:hover { background: #41454a; }
      button:focus-visible, select:focus-visible { outline: 2px solid #c1e4ff; outline-offset: 2px; }
      #sarashina-restore-btn { background: #c1e4ff; color: #18252f; border-color: transparent; }
      .sarashina-bar-close {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 36px;
        height: 36px;
        padding: 0;
        background: transparent;
        border: 0;
        font-size: 24px;
      }
    `;
  }
})();
