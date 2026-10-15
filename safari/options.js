// safari/options.js - Sarashina 翻訳 Safari拡張機能 設定画面制御

const ext = globalThis.browser || globalThis.chrome;

document.addEventListener("DOMContentLoaded", () => {
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
    apiKey: "",
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

  ext.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    apiKeyEl.value = items.apiKey || "";
    pageDefaultDirEl.value = items.pageDefaultDirection || DEFAULT_SETTINGS.pageDefaultDirection;
    apiBaseUrlEl.value = items.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl;
    apiModeEl.value = items.apiMode || DEFAULT_SETTINGS.apiMode;
    chatModelEl.value = items.chatModel || DEFAULT_SETTINGS.chatModel;
    updateModeVisibility();
  });

  toggleVisibilityBtn.addEventListener("click", () => {
    if (apiKeyEl.type === "password") {
      apiKeyEl.type = "text";
      toggleVisibilityBtn.textContent = "🙈";
    } else {
      apiKeyEl.type = "password";
      toggleVisibilityBtn.textContent = "👁️";
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const newSettings = {
      apiKey: apiKeyEl.value.trim(),
      apiBaseUrl: apiBaseUrlEl.value.trim() || DEFAULT_SETTINGS.apiBaseUrl,
      apiMode: apiModeEl.value,
      chatModel: chatModelEl.value,
      pageDefaultDirection: pageDefaultDirEl.value
    };

    saveBtn.disabled = true;
    saveBtn.textContent = "保存中...";

    ext.storage.sync.set(newSettings, () => {
      saveBtn.disabled = false;
      saveBtn.textContent = "設定を保存";
      showStatus("設定が正常に保存されました！", "success");
    });
  });

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
      const apiUrl = new URL(currentSettings.apiBaseUrl);
      if (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:") {
        throw new Error("APIベースURLには https:// または http:// で始まるURLを入力してください。");
      }
      // クリック操作の中で要求し、APIサイトの許可を得てから通信する。
      const granted = await ext.permissions.request({
        origins: [`${apiUrl.protocol}//${apiUrl.hostname}/*`]
      });
      if (!granted) {
        showStatus(`${apiUrl.hostname}へのアクセスが許可されませんでした。Safariの拡張機能設定で、このサイトへのアクセスを許可してください。`, "error");
        return;
      }

      const response = await ext.runtime.sendMessage({
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
});
