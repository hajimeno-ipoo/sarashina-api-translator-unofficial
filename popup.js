// popup.js - Sarashina 翻訳 ポップアップ制御（言語方向対応版）

document.addEventListener("DOMContentLoaded", async () => {
  const pageTranslateDirEl = document.getElementById("page-translate-dir");
  const translatePageBtn = document.getElementById("translate-page-btn");
  const sourceTextEl = document.getElementById("source-text");
  const textTranslateDirEl = document.getElementById("text-translate-dir");
  const translateBtn = document.getElementById("translate-btn");
  const resultGroupEl = document.getElementById("result-group");
  const resultTextEl = document.getElementById("result-text");
  const copyBtn = document.getElementById("copy-btn");
  const errorBoxEl = document.getElementById("error-box");
  const apiKeyWarningEl = document.getElementById("api-key-warning");
  const openSettingsIcon = document.getElementById("open-settings-icon");
  const openSettingsLink = document.getElementById("open-settings-link");

  // 設定確認
  chrome.storage.sync.get(["apiKey", "pageDefaultDirection"], (items) => {
    if (!items.apiKey || items.apiKey.trim() === "") {
      apiKeyWarningEl.style.display = "block";
    } else {
      apiKeyWarningEl.style.display = "none";
    }

    if (items.pageDefaultDirection && pageTranslateDirEl) {
      pageTranslateDirEl.value = items.pageDefaultDirection;
    }
  });

  // 設定画面を開く
  function openOptions() {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options.html"));
    }
  }

  openSettingsIcon.addEventListener("click", openOptions);
  openSettingsLink.addEventListener("click", openOptions);

  // 1. ページ全体翻訳ボタン
  const showReadingsBtn = document.getElementById("show-readings-btn");
  const removeReadingsBtn = document.getElementById("remove-readings-btn");
  async function requestPageReadings(remove) {
    clearError();
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
      showError(error.message);
    } finally {
      showReadingsBtn.disabled = removeReadingsBtn.disabled = false;
    }
  }
  showReadingsBtn.addEventListener("click", () => { void requestPageReadings(false); });
  removeReadingsBtn.addEventListener("click", () => { void requestPageReadings(true); });

  translatePageBtn.addEventListener("click", async () => {
    clearError();
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
      showError(err.message || "予期しないエラーが発生しました。");
      translatePageBtn.disabled = false;
      translatePageBtn.textContent = "ページ全体を翻訳";
    }
  });

  // 2. テキスト手動翻訳実行
  async function performTranslation() {
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
    resultGroupEl.style.display = "none";
    translateBtn.disabled = true;
    translateBtn.textContent = "翻訳中...";

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
        resultGroupEl.style.display = "block";
      } else {
        showError(response.error || "翻訳中にエラーが発生しました。");
      }
    } catch (err) {
      showError(err.message || "予期しないエラーが発生しました。");
    } finally {
      translateBtn.disabled = false;
      translateBtn.textContent = "翻訳";
    }
  }

  translateBtn.addEventListener("click", performTranslation);

  // Ctrl+Enter or Cmd+Enter で翻訳実行
  sourceTextEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      performTranslation();
    }
  });

  // コピー機能
  copyBtn.addEventListener("click", async () => {
    const text = resultTextEl.textContent;
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "完了！";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "コピー";
        copyBtn.classList.remove("copied");
      }, 1500);
    } catch (e) {
      console.error("クリップボードコピー失敗:", e);
    }
  });

  function showError(msg) {
    errorBoxEl.textContent = msg;
    errorBoxEl.style.display = "block";
  }

  function clearError() {
    errorBoxEl.textContent = "";
    errorBoxEl.style.display = "none";
  }
});
