// 選択した本文または入力欄を、保存した範囲に限って置換する。
(() => {
  if (globalThis.SarashinaSelectionReplacement) return;

  const targets = new Map();
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, "0")).join("");
  const excludedElements = "script, style, noscript, template";
  let nextId = 0;
  const failure = error => ({ success: false, error });
  const staleMessage = "選択した箇所がページ側で変更されています。文字を選び直して翻訳してください。";

  function editingElement(node) {
    if (!node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element;
  }

  function editableHost(node) {
    let element = editingElement(node);
    if (!element?.isContentEditable) return null;
    while (element.parentElement?.isContentEditable) element = element.parentElement;
    return element;
  }

  function inputError(element) {
    if (element.disabled) return "無効になっている入力欄は変更できません。";
    if (element.readOnly) return "読み取り専用の入力欄は変更できません。";
    if (element.tagName === "INPUT" && !["text", "search", "url", "tel", "email"].includes(element.type)) {
      return "この種類の入力欄は文字の置き換えに対応していません。";
    }
    if (typeof element.selectionStart !== "number" || typeof element.selectionEnd !== "number") {
      return "この入力欄では文字の選択範囲を取得できません。";
    }
    return "";
  }

  function saveTarget(target) {
    const targetId = `${documentId}:${++nextId}`;
    targets.set(targetId, target);
    return { success: true, targetId, kind: target.kind };
  }

  function edgeSpaces(text) {
    return { leading: text.match(/^\s*/)[0], trailing: text.match(/\s*$/)[0] };
  }

  function textOffset(host, node, offset) {
    const prefix = document.createRange();
    prefix.selectNodeContents(host);
    prefix.setEnd(node, offset);
    return prefix.toString().length;
  }

  function rangeAtOffsets(host, start, end) {
    const range = document.createRange();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let length = 0;
    let startFound = false;
    let node;
    while ((node = walker.nextNode())) {
      const nextLength = length + node.nodeValue.length;
      if (!startFound && start <= nextLength) {
        range.setStart(node, start - length);
        startFound = true;
      }
      if (startFound && end <= nextLength) {
        range.setEnd(node, end - length);
        return range;
      }
      length = nextLength;
    }
    if (!start && !end && !host.textContent) {
      range.selectNodeContents(host);
      range.collapse(true);
      return range;
    }
    return null;
  }

  function editableRangeAllowed(range, host) {
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return false;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node) && (!editingElement(node)?.isContentEditable || editingElement(node)?.closest(excludedElements))) {
        return false;
      }
    }
    return true;
  }

  function capture(expectedText) {
    if (typeof expectedText !== "string" || !expectedText.trim()) return failure("置き換える原文がありません。");
    const active = document.activeElement;
    if (active?.tagName === "INPUT" || active?.tagName === "TEXTAREA") {
      const error = inputError(active);
      if (error) return failure(error);
      const start = active.selectionStart;
      const end = active.selectionEnd;
      const original = active.value;
      const originalText = original.slice(start, end);
      if (start === end || originalText.trim() !== expectedText.trim()) {
        return failure("翻訳した原文と入力欄の選択範囲が一致しません。文字を選び直して翻訳してください。");
      }
      return saveTarget({ kind: "input", element: active, original, currentValue: original,
        start, end, currentEnd: end, originalText, ...edgeSpaces(originalText) });
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
      return failure("置き換える文字の選択範囲がありません。ページ本文を選び直してください。");
    }
    if (selection.toString().trim() !== expectedText.trim()) {
      return failure("翻訳した原文と現在の選択範囲が一致しません。文字を選び直して翻訳してください。");
    }

    const range = selection.getRangeAt(0).cloneRange();
    const host = editableHost(range.startContainer);
    if (host || editableHost(range.endContainer)) {
      if (!host || !editableRangeAllowed(range, host)) {
        return failure("選択範囲に編集できない領域が含まれています。同じ入力欄の文字だけを選び直してください。");
      }
      const start = textOffset(host, range.startContainer, range.startOffset);
      const end = textOffset(host, range.endContainer, range.endOffset);
      const originalText = selection.toString();
      return saveTarget({ kind: "editable", element: host, originalHTML: host.innerHTML,
        currentHTML: host.innerHTML, originalText, start, end, currentEnd: end,
        prefix: host.textContent.slice(0, start), suffix: host.textContent.slice(end),
        ...edgeSpaces(originalText) });
    }
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    while (node) {
      if (range.intersectsNode(node)) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
        if (end > start) {
          if (node.parentElement?.closest(excludedElements)) {
            return failure("選択範囲にページの実行用コードやスタイルが含まれています。画面に表示された本文だけを選択してください。");
          }
          if (editableHost(node) || editingElement(node)?.closest("input, textarea")) {
            return failure("選択範囲に入力欄や編集中の文章が含まれています。ページ本文だけを選択してください。");
          }
          parts.push({ node, start, end, original: node.nodeValue, parent: node.parentNode });
        }
      }
      node = walker.nextNode();
    }
    if (!parts.length || parts.some(part => !part.node.isConnected)) {
      return failure("置き換えられるページ本文が見つかりません。文字を選び直してください。");
    }
    const selectedText = parts.map(part => part.original.slice(part.start, part.end)).join("");
    return saveTarget({ kind: "text", parts, ...edgeSpaces(selectedText), appliedValues: null });
  }

  function validate(target) {
    return target.parts.every((part, index) => part.node.isConnected &&
      part.node.ownerDocument === document && part.node.parentNode === part.parent &&
      !editableHost(part.node) && !part.node.parentElement?.closest(excludedElements) &&
      part.node.nodeValue === (target.appliedValues ? target.appliedValues[index] : part.original));
  }

  function replace(targetId, translatedText) {
    const target = targets.get(targetId);
    if (!target) return failure("置き換え対象の保存が終了しています。文字を選び直して翻訳してください。");
    if (typeof translatedText !== "string" || !translatedText.trim()) return failure("置き換える訳文がありません。");
    if (target.kind !== "text") return updateEditor(target, target.leading + translatedText.trim() + target.trailing);
    if (!validate(target)) return failure(staleMessage);
    const values = target.parts.map((part, index) => part.original.slice(0, part.start) +
      (index === 0 ? target.leading + translatedText.trim() : "") +
      (index === target.parts.length - 1 ? target.trailing : "") + part.original.slice(part.end));
    target.parts.forEach((part, index) => { part.node.nodeValue = values[index]; });
    target.appliedValues = values;
    return { success: true };
  }

  function restore(targetId) {
    const target = targets.get(targetId);
    if (!target) return failure("元の文章の保存が終了しています。ページを再読み込みすると表示を戻せます。");
    if (target.kind !== "text") return updateEditor(target, target.originalText);
    if (!validate(target)) return failure(staleMessage);
    target.parts.forEach(part => { part.node.nodeValue = part.original; });
    target.appliedValues = null;
    return { success: true };
  }

  function editorIsCurrent(target) {
    const element = target.element;
    if (!element.isConnected || element.ownerDocument !== document) return false;
    return target.kind === "input" ? !inputError(element) && element.value === target.currentValue
      : element.isContentEditable && element.innerHTML === target.currentHTML;
  }

  function updateEditor(target, text) {
    const element = target.element;
    if (target.kind === "input") {
      const error = inputError(element);
      if (error) return failure(error);
      if (element.tagName === "INPUT" && /[\r\n]/.test(text)) {
        return failure("一行の入力欄には改行を含む訳文を入れられません。改行のない文章で翻訳し直してください。");
      }
      if (element.tagName === "TEXTAREA") text = text.replace(/\r\n?/g, "\n");
    }
    if (!editorIsCurrent(target)) return failure(staleMessage);
    const value = target.kind === "input" ? target.original.slice(0, target.start) + text + target.original.slice(target.end) : null;
    if (target.kind === "input" && element.maxLength >= 0 && value.length > element.maxLength) {
      return failure(`訳文を入れると入力欄の上限（${element.maxLength}文字）を超えます。`);
    }
    const range = target.kind === "editable" ? rangeAtOffsets(element, target.start, target.currentEnd) : null;
    if (target.kind === "editable" && (!range || !editableRangeAllowed(range, element))) {
      return failure("保存した選択範囲を編集できません。文字を選び直して翻訳してください。");
    }
    element.focus({ preventScroll: true });
    if (target.kind === "input") element.setSelectionRange(target.start, target.currentEnd);
    else {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const beforeInput = new InputEvent("beforeinput", { bubbles: true, composed: true,
      cancelable: true, inputType: "insertReplacementText", data: text });
    if (!element.dispatchEvent(beforeInput)) return failure("入力欄側が置き換えを受け付けませんでした。");
    if (!editorIsCurrent(target)) return failure(staleMessage);

    if (target.kind === "input") {
      const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.setSelectionRange(target.start + text.length, target.start + text.length);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true,
        inputType: "insertReplacementText", data: text }));
      if (element.value !== value) return failure("入力欄側で文章が変更されました。現在の文字を選び直して翻訳してください。");
      target.currentValue = value;
      target.currentEnd = target.start + text.length;
    } else {
      // beforeinput の処理でフォーカスや選択だけが動いても、保存した範囲へ入力する。
      element.focus({ preventScroll: true });
      if (!editorIsCurrent(target)) return failure(staleMessage);
      const editRange = rangeAtOffsets(element, target.start, target.currentEnd);
      if (!editRange || !editableRangeAllowed(editRange, element)) {
        return failure("保存した選択範囲を編集できません。文字を選び直して翻訳してください。");
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(editRange);
      if (!document.execCommand("insertText", false, text)) {
        return failure("この入力欄ではブラウザーの文字置き換えを実行できませんでした。");
      }
      const currentText = element.textContent;
      if (!currentText.startsWith(target.prefix) || !currentText.endsWith(target.suffix)) {
        return failure("入力欄側で文章が変更されました。現在の文字を選び直して翻訳してください。");
      }
      target.currentHTML = element.innerHTML;
      target.currentEnd = currentText.length - target.suffix.length;
    }
    return { success: true };
  }

  function release(targetId) {
    targets.delete(targetId);
  }

  globalThis.SarashinaSelectionReplacement = { capture, replace, restore, release };
})();
