// options.js - Sarashina 翻訳 設定画面制御

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("settings-form");
  const apiKeyEl = document.getElementById("api-key");
  const toggleVisibilityBtn = document.getElementById("toggle-key-visibility");
  const pageDefaultDirEl = document.getElementById("page-default-direction");
  const apiModeEl = document.getElementById("api-mode");
  const chatModelGroupEl = document.getElementById("chat-model-group");
  const chatModelEl = document.getElementById("chat-model");
  const apiBaseUrlEl = document.getElementById("api-base-url");
  const testBtn = document.getElementById("test-btn");
  const saveBtn = document.getElementById("save-btn");
  const statusBox = document.getElementById("status-box");

  const DEFAULT_SETTINGS = {
    apiBaseUrl: "https://api.sarashina.ai/v1",
    apiMode: "translate",
    chatModel: "sarashina3-mini",
    pageDefaultDirection: "en_to_ja"
  };

  function updateModeVisibility() {
    if (apiModeEl.value === "chat") {
      chatModelGroupEl.style.display = "block";
    } else {
      chatModelGroupEl.style.display = "none";
    }
  }

  apiModeEl.addEventListener("change", updateModeVisibility);

  // APIキーの表示・非表示切り替え
  toggleVisibilityBtn.addEventListener("click", () => {
    if (apiKeyEl.type === "password") {
      apiKeyEl.type = "text";
      toggleVisibilityBtn.textContent = "🙈";
    } else {
      apiKeyEl.type = "password";
      toggleVisibilityBtn.textContent = "👁️";
    }
  });

  // 設定保存
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saveBtn.disabled) return;

    const apiKey = apiKeyEl.value.trim();
    const newSettings = {
      apiBaseUrl: apiBaseUrlEl.value.trim() || DEFAULT_SETTINGS.apiBaseUrl,
      apiMode: apiModeEl.value,
      chatModel: chatModelEl.value,
      pageDefaultDirection: pageDefaultDirEl.value
    };

    saveBtn.disabled = true;
    saveBtn.textContent = "保存中...";

    try {
      await chrome.storage.sync.set(newSettings);
      await chrome.storage.local.set({ apiKey });
      showStatus("設定が正常に保存されました！", "success");
    } catch {
      showStatus("設定を保存できませんでした。", "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "設定を保存";
    }
  });

  // 接続テスト
  testBtn.addEventListener("click", async () => {
    const currentSettings = {
      apiKey: apiKeyEl.value.trim(),
      apiBaseUrl: apiBaseUrlEl.value.trim() || DEFAULT_SETTINGS.apiBaseUrl,
      apiMode: apiModeEl.value,
      chatModel: chatModelEl.value
    };

    if (!currentSettings.apiKey) {
      showStatus("接続テストを行う前にAPIキーを入力してください。", "error");
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "接続確認中...";
    showStatus("Sarashina APIへの接続をテストしています...", "success");

    try {
      const response = await chrome.runtime.sendMessage({
        action: "test_connection",
        settings: currentSettings
      });

      if (response && response.success) {
        showStatus(response.message || "API接続成功！", "success");
      } else {
        showStatus(response?.error || "接続テストに失敗しました。", "error");
      }
    } catch (err) {
      showStatus(`テスト送信エラー: ${err.message}`, "error");
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "接続テスト";
    }
  });

  function showStatus(message, type) {
    statusBox.textContent = message;
    statusBox.className = `status-msg ${type}`;
    statusBox.style.display = "block";
  }

  saveBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ action: "prepare_api_key_storage" });
    if (!response?.success) throw new Error(response?.error);

    const [items, { apiKey = "" }] = await Promise.all([
      chrome.storage.sync.get(DEFAULT_SETTINGS),
      chrome.storage.local.get("apiKey")
    ]);
    apiKeyEl.value = apiKey;
    pageDefaultDirEl.value = items.pageDefaultDirection || DEFAULT_SETTINGS.pageDefaultDirection;
    apiBaseUrlEl.value = items.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl;
    apiModeEl.value = items.apiMode || DEFAULT_SETTINGS.apiMode;
    chatModelEl.value = items.chatModel || DEFAULT_SETTINGS.chatModel;
    updateModeVisibility();
    saveBtn.disabled = false;
  } catch {
    showStatus("設定を読み込めませんでした。設定画面を開き直してください。", "error");
  }
});
