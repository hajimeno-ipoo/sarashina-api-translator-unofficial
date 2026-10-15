// safari/content.js - Sarashina 翻訳 Safari拡張機能 コンテンツスクリプト

(() => {
  const ext = globalThis.browser || globalThis.chrome;

  const POPUP_CONTAINER_ID = "sarashina-translator-container";
  const PAGE_BAR_CONTAINER_ID = "sarashina-page-bar-container";

  let selectionRequestId = 0;
  let selectionState = null;
  let selectionExpanded = false;
  let explanationRequestId = 0;
  let selectionExplanation = { status: "idle", text: "", error: "" };
  let nuanceRequestId = 0;
  let selectionNuance = { status: "idle", text: "", error: "" };
  let selectionReplacement = { target: null, applied: false, busy: false, message: "", appliedText: "" };

  let isPageTranslating = false;
  let isPageTranslated = false;
  let currentDirection = "en_to_ja";
  let translatedNodesList = [];
  let originalHtmlMarginTop = "";

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

  // メッセージリスナー
  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ping") {
      sendResponse({ pong: true });
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
        showSelectionModal({ status: "idle", sourceText, direction: "auto" });
        void explainSelection();
      } else {
        void translateSelection(sourceText);
      }
      sendResponse({ success: true });
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

  // 1. 選択テキスト翻訳モーダル
  async function translateSelection(sourceText, direction = "auto") {
    const text = sourceText.trim();
    if (!text) return;

    const requestId = ++selectionRequestId;
    ++explanationRequestId;
    selectionExplanation = { status: "idle", text: "", error: "" };
    ++nuanceRequestId;
    selectionNuance = { status: "idle", text: "", error: "" };
    showSelectionModal({ status: "loading", sourceText: text, direction });
    try {
      const response = await ext.runtime.sendMessage({ action: "translate", text, direction });
      if (requestId !== selectionRequestId) return;
      if (!response?.success || !response.data?.translatedText) {
        throw new Error(response?.error || "翻訳結果を取得できませんでした。再試行してください。");
      }
      showSelectionModal({
        status: "success", sourceText: text, direction,
        translatedText: response.data.translatedText, model: response.data.model
      });
    } catch (error) {
      if (requestId !== selectionRequestId) return;
      showSelectionModal({
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
    selectionExplanation = { status: "loading", text: "", error: "" };
    showSelectionModal(selectionState);
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
      showSelectionModal(selectionState);
    }
  }

  async function explainTranslationNuance() {
    if (!selectionState || selectionState.status !== "success" || selectionReplacement.busy
        || selectionExplanation.status === "loading" || selectionNuance.status === "loading") return;
    const selectionId = selectionRequestId;
    const requestId = ++nuanceRequestId;
    const { sourceText: text, translatedText } = selectionState;
    selectionNuance = { status: "loading", text: "", error: "" };
    showSelectionModal(selectionState);
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
      showSelectionModal(selectionState);
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
    showSelectionModal(selectionState);
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
        showSelectionModal(selectionState);
      }
    }
  }

  function onSelectionKeydown(event) {
    if (event.key === "Escape") removeSelectionModal();
  }

  function showSelectionModal(data) {
    selectionState = data;
    let container = document.getElementById(POPUP_CONTAINER_ID);
    const shouldFocus = !container || document.activeElement === container;
    if (!container) {
      container = document.createElement("div");
      container.id = POPUP_CONTAINER_ID;
      document.body.appendChild(container);
      document.addEventListener("keydown", onSelectionKeydown);
    }

    let shadow = container.shadowRoot;
    if (!shadow) {
      shadow = container.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = getSelectionModalStyles();
      shadow.appendChild(style);

      const wrapper = document.createElement("div");
      wrapper.id = "sarashina-card-wrapper";
      shadow.appendChild(wrapper);
    }

    const wrapper = shadow.getElementById("sarashina-card-wrapper");
    wrapper.innerHTML = renderSelectionCardContent(data);
    wrapper.classList.toggle("sarashina-expanded", selectionExpanded);
    if (shouldFocus) shadow.querySelector(".sarashina-close-btn").focus({ preventScroll: true });

    const directionSelect = shadow.querySelector(".sarashina-direction");
    directionSelect.onchange = () => { selectionState.direction = directionSelect.value; };
    const translateBtn = shadow.querySelector(".sarashina-retranslate-btn");
    translateBtn.onclick = () => {
      if (selectionState.status !== "loading" && !selectionReplacement.busy && selectionExplanation.status !== "loading" && selectionNuance.status !== "loading") {
        void translateSelection(selectionState.sourceText, selectionState.direction);
      }
    };
    const explainBtn = shadow.querySelector(".sarashina-explain-btn");
    explainBtn.onclick = () => { void explainSelection(); };
    const nuanceBtn = shadow.querySelector(".sarashina-nuance-btn");
    if (nuanceBtn) nuanceBtn.onclick = () => { void explainTranslationNuance(); };
    const replaceBtn = shadow.querySelector(".sarashina-replace-btn");
    if (replaceBtn) replaceBtn.onclick = () => { void updateSelectionReplacement(false); };
    const restoreBtn = shadow.querySelector(".sarashina-restore-selection-btn");
    if (restoreBtn) restoreBtn.onclick = () => { void updateSelectionReplacement(true); };
    const sizeBtn = shadow.querySelector(".sarashina-size-btn");
    sizeBtn.onclick = () => {
      selectionExpanded = !selectionExpanded;
      wrapper.classList.toggle("sarashina-expanded", selectionExpanded);
      sizeBtn.textContent = selectionExpanded ? "標準に戻す" : "拡大";
      sizeBtn.setAttribute("aria-pressed", String(selectionExpanded));
    };

    const closeBtn = shadow.querySelector(".sarashina-close-btn");
    if (closeBtn) {
      closeBtn.onclick = () => removeSelectionModal();
    }

    const copyBtn = shadow.querySelector(".sarashina-copy-btn");
    if (copyBtn && data.translatedText) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(data.translatedText);
          copyBtn.textContent = "コピー完了！";
          copyBtn.classList.add("copied");
          setTimeout(() => {
            copyBtn.textContent = "コピー";
            copyBtn.classList.remove("copied");
          }, 2000);
        } catch (e) {
          console.error("コピー失敗:", e);
        }
      };
    }
  }

  function removeSelectionModal() {
    ++explanationRequestId;
    selectionExplanation = { status: "idle", text: "", error: "" };
    ++nuanceRequestId;
    selectionNuance = { status: "idle", text: "", error: "" };
    releaseSelectionTarget();
    selectionReplacement = { target: null, applied: false, busy: false, message: "", appliedText: "" };
    ++selectionRequestId;
    selectionState = null;
    selectionExpanded = false;
    document.removeEventListener("keydown", onSelectionKeydown);
    const container = document.getElementById(POPUP_CONTAINER_ID);
    if (container) container.remove();
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

  function renderSelectionCardContent(data) {
    const isSuccess = data.status === "success";
    const sourceCharacterCount = Array.from(data.sourceText || "").length.toLocaleString("ja-JP");
    const translatedCharacterCount = Array.from(data.translatedText || "").length.toLocaleString("ja-JP");
    const isLoading = data.status === "loading";
    const isError = data.status === "error";
    const isExplaining = selectionExplanation.status === "loading";
    const isCheckingNuance = selectionNuance.status === "loading";
    const controlsDisabled = isLoading || selectionReplacement.busy || isExplaining || isCheckingNuance;

    return `
      <div class="sarashina-card" role="dialog" aria-label="選択テキストの翻訳">
        <div class="sarashina-header">
          <div class="sarashina-brand">
            <span class="sarashina-icon">⛩️</span>
            <span class="sarashina-title">Sarashina 翻訳 (Safari)（非公式）</span>
            ${data.model ? `<span class="sarashina-tag">${escapeHtml(data.model)}</span>` : ""}
          </div>
          <div class="sarashina-header-actions">
            <button class="sarashina-size-btn" aria-pressed="${selectionExpanded}">${selectionExpanded ? "標準に戻す" : "拡大"}</button>
            <button class="sarashina-close-btn" title="閉じる" aria-label="閉じる">&times;</button>
          </div>
        </div>

        <div class="sarashina-body">
          <div class="sarashina-section">
            <div class="sarashina-section-title">原文 <span class="sarashina-character-count sarashina-source-count">${sourceCharacterCount}文字</span></div>
            <div class="sarashina-source-text">${escapeHtml(data.sourceText)}</div>
          </div>

          <div class="sarashina-divider"></div>

          <div class="sarashina-section">
            <div class="sarashina-result-heading">
              <div class="sarashina-section-title">翻訳結果 ${isSuccess ? `<span class="sarashina-character-count sarashina-translated-count">${translatedCharacterCount}文字</span>` : ""}</div>
              ${isSuccess ? `<button class="sarashina-nuance-btn" ${controlsDisabled ? "disabled" : ""}>${isCheckingNuance ? "ニュアンスを確認中…" : selectionNuance.status === "error" ? "ニュアンスを再試行" : "訳文のニュアンス"}</button>` : ""}
            </div>
            ${data.status === "idle" ? `<div class="sarashina-translation-idle">翻訳はまだ実行していません。</div>` : ""}
            ${isLoading ? `
              <div class="sarashina-loading">
                <div class="sarashina-spinner"></div>
                <span>Sarashina AIが翻訳中...</span>
              </div>
            ` : ""}

            ${isSuccess ? `
              <div class="sarashina-translated-text">${escapeHtml(data.translatedText)}</div>
            ` : ""}

            ${isError ? `
              <div class="sarashina-error-message">
                <strong>エラー:</strong> ${escapeHtml(data.errorMessage)}
              </div>
            ` : ""}
          </div>
          ${selectionNuance.status !== "idle" ? `
            <div class="sarashina-divider"></div>
            <section class="sarashina-nuance-section" aria-label="訳文のニュアンス">
              <div class="sarashina-section-title">訳文のニュアンス <span class="sarashina-explanation-model">sarashina3-mini</span></div>
              ${isCheckingNuance ? `<div class="sarashina-loading" role="status"><div class="sarashina-spinner"></div><span>訳文のニュアンスを確認中…</span></div>` : ""}
              ${selectionNuance.status === "success" ? `<div class="sarashina-nuance-text">${escapeHtml(selectionNuance.text)}</div>` : ""}
              ${selectionNuance.status === "error" ? `<div class="sarashina-error-message" role="alert">${escapeHtml(selectionNuance.error)}</div>` : ""}
            </section>
          ` : ""}
          ${selectionExplanation.status !== "idle" ? `
            <div class="sarashina-divider"></div>
            <section class="sarashina-explanation-section" aria-label="選択部分の解説">
              <div class="sarashina-section-title">解説 <span class="sarashina-explanation-model">sarashina3-mini</span></div>
              ${isExplaining ? `<div class="sarashina-loading" role="status"><div class="sarashina-spinner"></div><span>解説を作成中…</span></div>` : ""}
              ${selectionExplanation.status === "success" ? `<div class="sarashina-explanation-text">${escapeHtml(selectionExplanation.text)}</div>` : ""}
              ${selectionExplanation.status === "error" ? `<div class="sarashina-error-message" role="alert">${escapeHtml(selectionExplanation.error)}</div>` : ""}
            </section>
          ` : ""}
        </div>

        <div class="sarashina-footer">
          <label class="sarashina-direction-label" for="sarashina-selection-direction">翻訳方向</label>
          <select id="sarashina-selection-direction" class="sarashina-direction" ${controlsDisabled ? "disabled" : ""}>
            <option value="auto" ${data.direction === "auto" ? "selected" : ""}>自動判定</option>
            <option value="en_to_ja" ${data.direction === "en_to_ja" ? "selected" : ""}>英語 → 日本語</option>
            <option value="ja_to_en" ${data.direction === "ja_to_en" ? "selected" : ""}>日本語 → 英語</option>
          </select>
          <button class="sarashina-retranslate-btn" ${controlsDisabled ? "disabled" : ""}>${isError ? "再試行" : isLoading ? "翻訳中…" : data.status === "idle" ? "翻訳" : "再翻訳"}</button>
          <div class="sarashina-result-actions">
            <button class="sarashina-explain-btn" ${controlsDisabled ? "disabled" : ""}>${isExplaining ? "解説中…" : selectionExplanation.status === "error" ? "解説を再試行" : "解説"}</button>
            ${isSuccess ? `<button class="sarashina-copy-btn">コピー</button>` : ""}
          </div>
          ${(isSuccess || selectionReplacement.applied) ? `
            <div class="sarashina-replacement-controls">
              ${isSuccess ? `<button class="sarashina-replace-btn" ${!selectionReplacement.target || controlsDisabled || selectionReplacement.appliedText === data.translatedText ? "disabled" : ""}>${selectionReplacement.applied ? "訳文を更新" : "原文を訳文に置き換える"}</button>` : ""}
              ${selectionReplacement.applied ? `<button class="sarashina-restore-selection-btn" ${controlsDisabled ? "disabled" : ""}>原文に戻す</button>` : ""}
            </div>
          ` : ""}
          ${selectionReplacement.message ? `<div class="sarashina-replacement-message" role="status">${escapeHtml(selectionReplacement.message)}</div>` : ""}
        </div>
      </div>
    `;
  }

  function getSelectionModalStyles() {
    return `
      :host {
        all: initial;
        position: fixed !important;
        top: 24px !important;
        bottom: 24px !important;
        left: 24px !important;
        right: 24px !important;
        display: flex !important;
        justify-content: flex-end !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
      }
      #sarashina-card-wrapper {
        width: 380px;
        max-width: 100%;
        height: 100%;
        display: flex;
        align-items: flex-end;
      }
      #sarashina-card-wrapper.sarashina-expanded {
        width: 680px;
      }
      .sarashina-card {
        pointer-events: auto;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        max-height: 100%;
        width: 100%;
        max-width: 100%;
        background: #ffffff;
        color: #1e293b;
        border-radius: 12px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
        border: 1px solid #e2e8f0;
        overflow: hidden;
        animation: sarashina-fade-in 0.25s ease-out;
      }
      .sarashina-expanded .sarashina-body {
        max-height: 65vh;
      }
      .sarashina-expanded .sarashina-source-text {
        max-height: 180px;
      }
      .sarashina-header, .sarashina-footer {
        flex-shrink: 0;
      }
      .sarashina-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .sarashina-size-btn {
        background: #ffffff;
        color: #475569;
        border: 1px solid #cbd5e1;
        border-radius: 5px;
        padding: 4px 8px;
        cursor: pointer;
        white-space: nowrap;
      }
      @keyframes sarashina-fade-in {
        from { opacity: 0; transform: translateY(12px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .sarashina-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: #f8fafc;
        border-bottom: 1px solid #e2e8f0;
      }
      .sarashina-brand {
        min-width: 0;
        flex-wrap: wrap;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .sarashina-icon {
        font-size: 16px;
      }
      .sarashina-title {
        font-size: 14px;
        font-weight: 700;
        color: #0f172a;
      }
      .sarashina-tag {
        font-size: 11px;
        background: #ffe4e6;
        color: #e11d48;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 600;
      }
      .sarashina-close-btn {
        background: none;
        border: none;
        font-size: 20px;
        color: #64748b;
        cursor: pointer;
        line-height: 1;
        padding: 0 4px;
      }
      .sarashina-close-btn:hover {
        color: #0f172a;
      }
      .sarashina-body {
        min-height: 0;
        padding: 16px;
        max-height: 380px;
        overflow-y: auto;
      }
      .sarashina-section-title {
        font-size: 11px;
        font-weight: 700;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .sarashina-character-count {
        margin-left: 6px;
        font-size: 11px;
        font-weight: 400;
        letter-spacing: normal;
        white-space: nowrap;
      }
      .sarashina-source-text {
        font-size: 13px;
        color: #475569;
        line-height: 1.5;
        background: #f8fafc;
        padding: 8px 10px;
        border-radius: 6px;
        max-height: 80px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .sarashina-divider {
        height: 1px;
        background: #f1f5f9;
        margin: 12px 0;
      }
      .sarashina-translated-text {
        font-size: 14px;
        line-height: 1.6;
        color: #0f172a;
        white-space: pre-wrap;
        word-break: break-word;
        font-weight: 500;
      }
      .sarashina-loading {
        display: flex;
        align-items: center;
        gap: 10px;
        color: #e11d48;
        font-size: 13px;
        padding: 12px 0;
      }
      .sarashina-spinner {
        width: 18px;
        height: 18px;
        border: 2px solid #ffe4e6;
        border-top: 2px solid #e11d48;
        border-radius: 50%;
        animation: sarashina-spin 0.8s linear infinite;
      }
      @keyframes sarashina-spin {
        to { transform: rotate(360deg); }
      }
      .sarashina-error-message {
        font-size: 13px;
        color: #b91c1c;
        background: #fef2f2;
        padding: 10px;
        border-radius: 6px;
        border-left: 3px solid #ef4444;
        line-height: 1.5;
      }
      .sarashina-footer {
        padding: 10px 16px;
        background: #f8fafc;
        border-top: 1px solid #e2e8f0;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .sarashina-direction-label {
        font-size: 12px;
        color: #475569;
      }
      .sarashina-direction {
        min-width: 0;
        flex: 1;
        background: #ffffff;
        color: #1e293b;
        border: 1px solid #cbd5e1;
        border-radius: 5px;
        padding: 5px;
        font-size: 12px;
      }
      .sarashina-retranslate-btn {
        color: #e11d48;
        background: #ffffff;
        border: 1px solid #e11d48;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .sarashina-retranslate-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .sarashina-result-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        flex-basis: 100%;
      }
      .sarashina-result-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 6px;
      }
      .sarashina-result-heading .sarashina-section-title {
        margin-bottom: 0;
      }
      .sarashina-explain-btn, .sarashina-nuance-btn {
        color: #1d4ed8;
        background: #ffffff;
        border: 1px solid #93c5fd;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .sarashina-explain-btn:disabled, .sarashina-nuance-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .sarashina-explanation-text, .sarashina-nuance-text {
        font-size: 13px;
        line-height: 1.7;
        color: #0f172a;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .sarashina-explanation-model {
        font-size: 10px;
        font-weight: 500;
        color: #1d4ed8;
        text-transform: none;
        letter-spacing: normal;
      }
      .sarashina-translation-idle {
        font-size: 12px;
        color: #64748b;
      }
      .sarashina-replacement-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        flex-basis: 100%;
      }
      .sarashina-replace-btn, .sarashina-restore-selection-btn {
        background: #ffffff;
        color: #334155;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
      }
      .sarashina-replace-btn:disabled, .sarashina-restore-selection-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .sarashina-replacement-message {
        flex-basis: 100%;
        font-size: 12px;
        line-height: 1.5;
        color: #475569;
        overflow-wrap: anywhere;
      }
      .sarashina-copy-btn {
        background: #e11d48;
        color: #ffffff;
        border: none;
        padding: 6px 14px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 6px;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .sarashina-copy-btn:hover {
        background: #be123c;
      }
      .sarashina-copy-btn.copied {
        background: #16a34a;
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

    const dirLabel = direction === "en_to_ja" ? "英語 → 日本語" : "日本語 → 英語";
    showPageBar(`ページ構造を解析中 (${dirLabel})...`, "loading");

    const targetNodes = collectTranslatableTextNodes(document.body, direction);

    if (targetNodes.length === 0) {
      const msg = direction === "en_to_ja"
        ? "翻訳対象の英語テキストが見つかりませんでした（既に日本語です）。"
        : "翻訳対象の日本語テキストが見つかりませんでした。";
      showPageBar(msg, "completed");
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
        showPageBar(`ページ翻訳中... [${dirLabel}] (${completedChunks + 1}/${totalChunks} ブロック)`, "loading");

        const indexedLines = chunk.map((item, idx) => `[${idx + 1}] ${item.text}`).join("\n");

        const response = await ext.runtime.sendMessage({
          action: "translate",
          text: indexedLines,
          direction: currentDirection
        });

        if (response?.success === false && response.errorCode === "API_KEY_REQUIRED") {
          showPageBar(`翻訳エラー: ${response.error}`, "error");
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

          if (translatedVal && translatedVal !== item.text) {
            translatedNodesList.push({
              node: item.node,
              originalValue: item.node.nodeValue
            });

            const leadingSpaces = item.node.nodeValue.match(/^\s*/)[0];
            const trailingSpaces = item.node.nodeValue.match(/\s*$/)[0];
            item.node.nodeValue = leadingSpaces + translatedVal + trailingSpaces;
          }
        }

        completedChunks++;
      }

      isPageTranslated = true;
      showPageBar(`✅ ページの翻訳完了！ (${dirLabel})`, "completed");
    } catch (err) {
      console.error("ページ翻訳エラー:", err);
      showPageBar(`翻訳エラー: ${err.message}`, "error");
    } finally {
      isPageTranslating = false;
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
    if (!isPageTranslated || translatedNodesList.length === 0) return;

    for (const item of translatedNodesList) {
      try {
        if (item.node) {
          item.node.nodeValue = item.originalValue;
        }
      } catch (e) {
        console.warn("復元エラー:", e);
      }
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
    let container = document.getElementById(PAGE_BAR_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = PAGE_BAR_CONTAINER_ID;
      document.body.prepend(container);

      originalHtmlMarginTop = document.documentElement.style.marginTop || "";
      document.documentElement.style.marginTop = "44px";
    }

    let shadow = container.shadowRoot;
    if (!shadow) {
      shadow = container.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = getPageBarStyles();
      shadow.appendChild(style);

      const wrapper = document.createElement("div");
      wrapper.id = "sarashina-bar-wrapper";
      shadow.appendChild(wrapper);
    }

    const wrapper = shadow.getElementById("sarashina-bar-wrapper");
    wrapper.innerHTML = `
      <div class="sarashina-page-bar">
        <div class="sarashina-bar-left">
          <span class="sarashina-bar-icon">⛩️</span>
          <span class="sarashina-bar-brand">Sarashina 翻訳 (Safari)（非公式）</span>
          <span class="sarashina-bar-msg">${escapeHtml(message)}</span>
        </div>
        <div class="sarashina-bar-actions">
          <select id="sarashina-bar-dir-select" class="sarashina-bar-select">
            <option value="en_to_ja" ${currentDirection === "en_to_ja" ? "selected" : ""}>英語 → 日本語</option>
            <option value="ja_to_en" ${currentDirection === "ja_to_en" ? "selected" : ""}>日本語 → 英語</option>
          </select>
          <button id="sarashina-switch-dir-btn" class="sarashina-bar-btn translate" title="選択した方向で再翻訳">翻訳実行</button>
          ${isPageTranslated ? `
            <button id="sarashina-restore-btn" class="sarashina-bar-btn restore">原文に戻す</button>
          ` : ""}
          <button id="sarashina-bar-close-btn" class="sarashina-bar-close" title="バーを閉じる">&times;</button>
        </div>
      </div>
    `;

    const switchBtn = shadow.getElementById("sarashina-switch-dir-btn");
    const dirSelect = shadow.getElementById("sarashina-bar-dir-select");
    if (switchBtn && dirSelect) {
      switchBtn.onclick = () => {
        const chosenDir = dirSelect.value;
        startFullPageTranslation(chosenDir);
      };
    }

    const restoreBtn = shadow.getElementById("sarashina-restore-btn");
    if (restoreBtn) {
      restoreBtn.onclick = () => restoreOriginalPage();
    }

    const closeBtn = shadow.getElementById("sarashina-bar-close-btn");
    if (closeBtn) {
      closeBtn.onclick = () => {
        container.remove();
        document.documentElement.style.marginTop = originalHtmlMarginTop;
      };
    }
  }

  function getPageBarStyles() {
    return `
      :host {
        all: initial;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        width: 100vw !important;
        height: 44px !important;
        z-index: 2147483647 !important;
        display: block !important;
        box-sizing: border-box !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
      }
      .sarashina-page-bar {
        background: #0f172a;
        color: #f8fafc;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 16px;
        height: 44px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        font-size: 13px;
        border-bottom: 2px solid #e11d48;
        box-sizing: border-box;
      }
      .sarashina-bar-left {
        display: flex;
        align-items: center;
        gap: 10px;
        overflow: hidden;
      }
      .sarashina-bar-icon {
        font-size: 16px;
      }
      .sarashina-bar-brand {
        font-weight: 700;
        color: #fca5a5;
        white-space: nowrap;
      }
      .sarashina-bar-msg {
        color: #e2e8f0;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
      }
      .sarashina-bar-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }
      .sarashina-bar-select {
        background: #1e293b;
        color: #f8fafc;
        border: 1px solid #475569;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 12px;
        outline: none;
      }
      .sarashina-bar-btn {
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        transition: opacity 0.15s ease;
      }
      .sarashina-bar-btn.restore {
        background: #334155;
        color: #f8fafc;
      }
      .sarashina-bar-btn.restore:hover {
        background: #475569;
      }
      .sarashina-bar-btn.translate {
        background: #e11d48;
        color: #ffffff;
      }
      .sarashina-bar-btn.translate:hover {
        background: #be123c;
      }
      .sarashina-bar-close {
        background: none;
        border: none;
        color: #94a3b8;
        font-size: 20px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .sarashina-bar-close:hover {
        color: #ffffff;
      }
    `;
  }
})();
