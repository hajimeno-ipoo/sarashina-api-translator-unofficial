// popup.js - Sarashina 翻訳 ポップアップ制御（言語方向対応版）

document.addEventListener("DOMContentLoaded", async () => {
  const pageTranslateDirEl = document.getElementById("page-translate-dir");
  const translatePageBtn = document.getElementById("translate-page-btn");
  const sourceTextEl = document.getElementById("source-text");
  const textTranslateDirEl = document.getElementById("text-translate-dir");
  const translateBtn = document.getElementById("translate-btn");
  const resultGroupEl = document.getElementById("result-group");
  const resultTextEl = document.getElementById("result-text");
  const resultProgress = document.getElementById("result-progress");
  const resultContent = document.getElementById("result-content");
  const copyBtn = document.getElementById("copy-btn");
  const errorBoxEl = document.getElementById("error-box");
  const pageErrorBox = document.getElementById("page-error-box");
  const settingsErrorBox = document.getElementById("settings-error-box");
  const apiKeyWarningEl = document.getElementById("api-key-warning");
  const openSettingsIcon = document.getElementById("open-settings-icon");
  const openSettingsLink = document.getElementById("open-settings-link");

  // 設定画面を開く
  function openOptions(event) {
    event.preventDefault();
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  }

  openSettingsIcon.addEventListener("click", openOptions);
  openSettingsLink.addEventListener("click", openOptions);

  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  function selectTab(selectedTab) {
    for (const tab of tabs) {
      const active = tab === selectedTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      let next;
      switch (event.key) {
        case "ArrowLeft": next = tabs[(index - 1 + tabs.length) % tabs.length]; break;
        case "ArrowRight": next = tabs[(index + 1) % tabs.length]; break;
        case "Home": next = tabs[0]; break;
        case "End": next = tabs[tabs.length - 1]; break;
        default: return;
      }
      event.preventDefault();
      selectTab(next);
      next.focus();
    });
  }

  // 1. ページ全体翻訳ボタン
  const showReadingsBtn = document.getElementById("show-readings-btn");
  const removeReadingsBtn = document.getElementById("remove-readings-btn");
  async function requestPageReadings(remove) {
    clearError(pageErrorBox);
    showReadingsBtn.disabled = removeReadingsBtn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!Number.isInteger(tab?.id) || tab.id < 0 || !/^https?:\/\//.test(tab.url || "")) {
        throw new Error("通常のWebサイト（https://〜）でお試しください。");
      }
      const response = await chrome.runtime.sendMessage({
        action: remove ? "remove_page_readings" : "launch_page_readings", tabId: tab.id
      });
      if (!response?.success) throw new Error(response?.error || "読み付けを起動できませんでした。");
      window.close();
    } catch (error) {
      showError(error.message, pageErrorBox);
    } finally {
      showReadingsBtn.disabled = removeReadingsBtn.disabled = false;
    }
  }
  showReadingsBtn.addEventListener("click", () => { void requestPageReadings(false); });
  removeReadingsBtn.addEventListener("click", () => { void requestPageReadings(true); });

  translatePageBtn.addEventListener("click", async () => {
    clearError(pageErrorBox);
    translatePageBtn.disabled = true;
    translatePageBtn.textContent = "起動中...";

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        throw new Error("アクティブなタブを取得できませんでした。");
      }

      const url = tab.url || "";
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("Chrome内部ページや設定画面（chrome://等）では拡張機能の実行が制限されています。通常のWebサイト（https://〜）でお試しください。");
      }

      const direction = pageTranslateDirEl ? pageTranslateDirEl.value : "en_to_ja";

      // background 経由で確実にスクリプトを注入・起動
      const response = await chrome.runtime.sendMessage({
        action: "launch_page_translation",
        tabId: tab.id,
        direction: direction
      });

      if (response && response.success) {
        window.close();
      } else {
        throw new Error(response?.error || "ページ全体翻訳の起動に失敗しました。");
      }
    } catch (err) {
      showError(err.message || "予期しないエラーが発生しました。", pageErrorBox);
      translatePageBtn.disabled = false;
      translatePageBtn.textContent = "ページ全体を翻訳";
    }
  });

  // 2. テキスト手動翻訳実行
  async function performTranslation() {
    if (translateBtn.disabled) return;
    const text = sourceTextEl.value.trim();
    if (!text) {
      showError("翻訳するテキストを入力してください。");
      return;
    }

    if (text.length > 5000) {
      showError("Sarashina Translate APIの上限文字数（5,000文字）を超えています。");
      return;
    }

    clearError();
    resultGroupEl.hidden = false;
    resultProgress.hidden = false;
    resultContent.hidden = true;
    translateBtn.disabled = true;
    const unmountLoading = globalThis.SarashinaFeedback?.mountLoading(
      document.getElementById("result-orb"), { size: 32 }
    );

    const direction = textTranslateDirEl.value;

    try {
      const response = await chrome.runtime.sendMessage({
        action: "translate",
        text: text,
        direction: direction
      });

      if (!response) {
        throw new Error("拡張機能バックグラウンドから応答がありませんでした。chrome://extensions で拡張機能を再読み込みしてください。");
      }

      if (response.success) {
        resultTextEl.textContent = response.data.translatedText;
        resultContent.hidden = false;
      } else {
        showError(response.error || "翻訳中にエラーが発生しました。");
      }
    } catch (err) {
      showError(err.message || "予期しないエラーが発生しました。");
    } finally {
      unmountLoading?.();
      resultProgress.hidden = true;
      resultGroupEl.hidden = resultContent.hidden;
      translateBtn.disabled = false;
    }
  }

  translateBtn.addEventListener("click", performTranslation);

  // Ctrl+Enter or Cmd+Enter で翻訳実行
  sourceTextEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void performTranslation();
    }
  });

  // コピー機能
  copyBtn.addEventListener("click", async () => {
    const text = resultTextEl.textContent;
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "コピー済み";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "コピー";
        copyBtn.classList.remove("copied");
      }, 1500);
    } catch (e) {
      console.error("クリップボードコピー失敗:", e);
    }
  });

  function showError(message, box = errorBoxEl) {
    box.textContent = message;
    box.hidden = false;
  }

  function clearError(box = errorBoxEl) {
    box.textContent = "";
    box.hidden = true;
  }

  try {
    const response = await chrome.runtime.sendMessage({ action: "prepare_api_key_storage" });
    if (!response?.success) throw new Error(response?.error);

    const [{ pageDefaultDirection }, { apiKey }] = await Promise.all([
      chrome.storage.sync.get("pageDefaultDirection"),
      chrome.storage.local.get("apiKey")
    ]);
    apiKeyWarningEl.hidden = Boolean(apiKey?.trim());
    if (pageDefaultDirection) pageTranslateDirEl.value = pageDefaultDirection;
  } catch {
    showError("設定を読み込めませんでした。ポップアップを開き直してください。", settingsErrorBox);
  }
});
