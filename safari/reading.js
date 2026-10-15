// 英日ルビ表示。本文と要素の対応はブラウザ側で保持し、AIには文字列だけを渡す。
(() => {
  if (globalThis.SarashinaReading) return;
  const ext = globalThis.browser || globalThis.chrome;
  const BAR_ID = "sarashina-reading-bar";
  const EXCLUDED = "script,style,noscript,input,textarea,select,option,code,pre,svg,canvas,iframe,audio,video,ruby,rt,mat-icon,mwc-icon,.material-icons,[class*='material-symbols'],[contenteditable]:not([contenteditable='false']),[aria-hidden='true']";
  const BLOCKS = new Set(["BODY", "DIV", "P", "LI", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "BLOCKQUOTE", "FIGCAPTION", "BUTTON"]);
  let generation = 0;
  let running = false;
  let enabled = false;
  let mode = "page";
  let selectionParts = null;
  let dirty = false;
  let updateTimer = null;
  let activePromise = null;
  let ownDOMDepth = 0;
  let requestCount = 0;
  let cacheHitCount = 0;
  const cache = new Map();
  const inFlight = new Map();
  const observer = new MutationObserver(mutations => {
    if (!enabled || !mutations.some(isRelevantMutation)) return;
    dirty = true;
    if (!running) scheduleUpdate();
  });
  let count = 0;
  let skipped = 0;
  let records = [];
  let bar = null;
  let skipElement = () => false;

  function isRelevantMutation(mutation) {
    const element = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
    return !element?.closest("script,style,noscript,input,textarea,select,option,code,pre,svg,canvas,[id^='sarashina-']");
  }

  function observe() {
    if (enabled && mode === "page") observer.observe(document.documentElement, {
      childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "contenteditable"]
    });
  }

  function ownDOM(work) {
    if (ownDOMDepth++ === 0) {
      if (enabled && mode === "page" && observer.takeRecords().some(isRelevantMutation)) dirty = true;
      observer.disconnect();
    }
    try { return work(); }
    finally { if (--ownDOMDepth === 0) observe(); }
  }

  function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      if (enabled && !running) activePromise = refresh(generation);
    }, 600);
  }

  function showStatus(message) {
    ownDOM(() => renderStatus(message));
  }

  function renderStatus(message) {
    if (!bar?.isConnected) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      const shadow = bar.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ":host{all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:calc(100vw - 32px)}.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;max-width:480px;padding:12px 16px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#0f172a;box-shadow:0 4px 20px #0003;font:14px/1.6 system-ui,sans-serif}button{padding:6px 12px;border:1px solid #94a3b8;border-radius:6px;background:#f1f5f9;color:#0f172a;font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #e11d48;outline-offset:2px}";
      const panel = document.createElement("div");
      panel.className = "bar";
      const status = document.createElement("span");
      status.setAttribute("role", "status");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.onclick = () => {
        if (enabled) removeReadings(true);
        else void resume();
      };
      panel.append(status, remove);
      shadow.append(style, panel);
      document.documentElement.append(bar);
    }
    bar.shadowRoot.querySelector("[role=status]").textContent = mode === "selection" ? `選択部分: ${message}` : message;
    bar.shadowRoot.querySelector("button").textContent = enabled ? "読みを外す" : "再表示";
  }

  function collectRuns() {
    const runs = [];
    let current = null;
    function flush() { current = null; }
    function walk(node, owner) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.nodeValue) return;
        if (!current || current.owner !== owner) {
          current = { owner, text: "", parts: [] };
          runs.push(current);
        }
        const start = current.text.length;
        current.text += node.nodeValue;
        current.parts.push({ node, text: node.nodeValue, start, end: current.text.length });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches(EXCLUDED) || node.id.startsWith("sarashina-") || skipElement(node)) {
        flush();
        return;
      }
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") { flush(); return; }
      if (node.tagName === "BR") { flush(); return; }
      const isBlock = BLOCKS.has(node.tagName);
      if (isBlock) flush();
      for (const child of node.childNodes) walk(child, isBlock ? node : owner);
      if (isBlock) flush();
    }
    if (document.body) walk(document.body, document.body);
    return runs.filter(run => /[A-Za-z\p{Script=Han}]/u.test(run.text));
  }

  function makeBatches(runs) {
    const items = [];
    for (const run of runs) {
      let offset = 0;
      while (offset < run.text.length) {
        let end = Math.min(offset + 1000, run.text.length);
        if (end < run.text.length) {
          const candidate = run.text.slice(offset, end);
          const breaks = [...candidate.matchAll(/[\s。！？.!?]/g)];
          if (breaks.length) end = offset + breaks[breaks.length - 1].index + 1;
          else {
            // 長い単語は途中で切らず、その部分を対象外とする。
            const next = run.text.slice(end).search(/[\s。！？.!?]/);
            const boundary = next < 0 ? run.text.length : end + next + 1;
            skipped++;
            offset = boundary;
            continue;
          }
        }
        const text = run.text.slice(offset, end);
        if (/[A-Za-z\p{Script=Han}]/u.test(text)) {
          const item = { id: String(items.length), text, run, offset,
            key: JSON.stringify([run.text, offset, text]) };
          items.push(item);
          (run.items ||= []).push(item);
        }
        offset = end;
      }
    }
    const batches = [];
    let batch = [], length = 0;
    for (const item of items) {
      if (batch.length && (length + item.text.length > 1200 || batch.length >= 32)) {
        batches.push(batch); batch = []; length = 0;
      }
      batch.push(item); length += item.text.length;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  function validateItems(batch, result) {
    if (!Array.isArray(result) || result.length !== batch.length) throw new Error("読みの返答と原文が一致しません。もう一度お試しください。");
    const ids = new Set();
    for (const item of batch) {
      const output = result.find(value => value?.id === item.id);
      if (!output || ids.has(output.id) || !Array.isArray(output.segments)
          || output.segments.some(segment => typeof segment.text !== "string" || !segment.text
            || typeof segment.reading !== "string"
            || (segment.reading && (segment.reading.length > 200
              || !/^[\u3041-\u3096\u30A1-\u30FAー]+(?:[・ ][\u3041-\u3096\u30A1-\u30FAー]+)*$/.test(segment.reading))))
          || output.segments.map(segment => segment.text).join("") !== item.text) {
        throw new Error("読みの返答と原文が一致しません。もう一度お試しください。");
      }
      ids.add(output.id);
    }
  }

  function applyBatch(batch, result) {
    validateItems(batch, result);
    const edits = new Map();
    for (const item of batch) {
      // 文脈が変わっていた場合、その文の読みを適用しない。
      if (item.run.parts.some(part => !part.node.isConnected || part.node.nodeValue !== part.text
          || (part.parent && part.node.parentNode !== part.parent))) {
        skipped++; continue;
      }
      let offset = item.offset;
      for (const segment of result.find(value => value.id === item.id).segments) {
        const end = offset + segment.text.length;
        if (segment.reading) {
          const part = item.run.parts.find(value => value.start <= offset && value.end >= end);
          if (part) {
            if (!edits.has(part.node)) edits.set(part.node, []);
            edits.get(part.node).push({ start: offset - part.start + (part.sourceOffset || 0), end: end - part.start + (part.sourceOffset || 0), reading: segment.reading });
          } else skipped++;
        }
        offset = end;
      }
    }
    for (const [node, ranges] of edits) {
      const original = node.nodeValue;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const range of ranges.sort((a, b) => a.start - b.start)) {
        if (range.start > offset) fragment.append(document.createTextNode(original.slice(offset, range.start)));
        const ruby = document.createElement("ruby");
        ruby.style.setProperty("ruby-position", "over", "important");
        ruby.style.setProperty("ruby-align", "center", "important");
        const base = document.createTextNode(original.slice(range.start, range.end));
        const rt = document.createElement("rt");
        rt.textContent = range.reading;
        rt.style.setProperty("font-size", "0.55em", "important");
        ruby.append(base, rt);
        fragment.append(ruby);
        count++;
        offset = range.end;
      }
      if (offset < original.length) fragment.append(document.createTextNode(original.slice(offset)));
      const nodes = [...fragment.childNodes];
      records.push({ original: node, nodes, html: nodes.map(value => value.nodeType === Node.TEXT_NODE ? value.nodeValue : value.outerHTML) });
      node.replaceWith(fragment);
    }
  }

  function recordUnchanged(record) {
    const { nodes, html } = record;
    return nodes.every((node, index) => node.isConnected
      && node.parentNode === nodes[0].parentNode
      && (index === 0 || nodes[index - 1].nextSibling === node)
      && (node.nodeType === Node.TEXT_NODE ? node.nodeValue : node.outerHTML) === html[index]);
  }

  function selectionError() {
    return new Error("選択範囲の本文が変わりました。読みを付ける文章を選び直してください。");
  }

  function captureSelection(expectedText) {
    const active = document.activeElement;
    if (active?.matches("input,textarea,select") || active?.isContentEditable) {
      throw new Error("入力欄にはルビを表示できません。ページ本文を選び直してください。");
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed
        || typeof expectedText !== "string" || !expectedText.trim()
        || selection.toString().trim() !== expectedText.trim()) throw selectionError();
    const range = selection.getRangeAt(0);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const selected = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : node.nodeValue.length;
      if (start >= end) continue;
      const parent = node.parentElement;
      let hidden = false;
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hidden || style.display === "none" || style.visibility === "hidden") {
          hidden = true;
          break;
        }
      }
      if (hidden) continue;
      const record = records.find(value => value.nodes.some(element => element === node || element.contains?.(node)));
      if (parent?.closest("rt")) {
        if (record) continue;
        throw new Error("既存のルビを含む範囲には読みを付けられません。本文を選び直してください。");
      }
      const exclusion = record ? EXCLUDED.replace(",ruby,rt,", ",") : EXCLUDED;
      if (!parent || parent.closest(exclusion) || parent.closest("[id^='sarashina-']") || skipElement(parent)) {
        throw new Error("入力欄・コード・既存のルビなどは対象外です。本文を選び直してください。");
      }
      let source = node, sourceStart = start, sourceEnd = end;
      if (record) {
        if (!recordUnchanged(record)) throw selectionError();
        let offset = 0;
        let found = false;
        for (const generated of record.nodes) {
          const base = generated.nodeType === Node.TEXT_NODE ? generated : generated.firstChild;
          if (base === node) { source = record.original; sourceStart += offset; sourceEnd += offset; found = true; break; }
          offset += base?.textContent.length || 0;
        }
        if (!found) throw selectionError();
      }
      const previous = selected[selected.length - 1];
      if (previous?.node === source && previous.end === sourceStart) previous.end = sourceEnd;
      else selected.push({ node: source, text: source.nodeValue, start: sourceStart, end: sourceEnd,
        parent: record ? record.nodes[0].parentNode : source.parentNode });
    }
    if (!selected.length || !/[A-Za-z\p{Script=Han}]/u.test(selected.map(part => part.text.slice(part.start, part.end)).join(""))) {
      throw new Error("選択範囲に読みを付ける英語・漢字がありません。本文を選び直してください。");
    }
    return selected;
  }

  function collectSelectionRuns() {
    if (!selectionParts?.length) throw selectionError();
    const runs = [];
    let previous = null;
    for (const part of selectionParts) {
      if (!part.node.isConnected || part.node.nodeValue !== part.text || part.node.parentNode !== part.parent
          || (previous && !(previous.node.compareDocumentPosition(part.node) & Node.DOCUMENT_POSITION_FOLLOWING))) throw selectionError();
      const owner = part.node.parentElement.closest([...BLOCKS].join(",")) || part.parent;
      let run = runs[runs.length - 1];
      if (!run || run.owner !== owner) { run = { owner, text: "", parts: [] }; runs.push(run); }
      const start = run.text.length;
      run.text += part.text.slice(part.start, part.end);
      run.parts.push({ node: part.node, text: part.text, parent: part.parent,
        sourceOffset: part.start, start, end: run.text.length });
      previous = part;
    }
    return runs;
  }

  function restoreRecords() {
    for (const record of records) {
      const { original, nodes } = record;
      const unchanged = recordUnchanged(record);
      if (unchanged) {
        nodes[0].before(original);
        nodes.forEach(node => node.remove());
      } else {
        // サイトの更新を戻さず、残っている自分のルビだけ外す。
        for (const node of nodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.isConnected) {
            node.replaceWith(...[...node.childNodes].filter(child => child.nodeName !== "RT"));
          }
        }
      }
    }
    records = []; count = 0; skipped = 0;
  }

  function removeReadings(keepControls = false) {
    enabled = false;
    ++generation;
    running = false;
    dirty = false;
    clearTimeout(updateTimer);
    updateTimer = null;
    observer.disconnect();
    ownDOM(() => {
      restoreRecords();
      if (keepControls) renderStatus("読みを非表示にしました");
      else { bar?.remove(); bar = null; }
    });
  }

  async function loadBatch(batch) {
    const missing = [];
    const keys = new Set();
    for (const item of batch) {
      if (!cache.has(item.key) && !inFlight.has(item.key) && !keys.has(item.key)) {
        missing.push(item);
        keys.add(item.key);
      }
    }
    if (missing.length) {
      requestCount++;
      const packet = ext.runtime.sendMessage({ action: "generate_readings", items: missing.map(({ id, text }) => ({ id, text })) })
        .then(response => {
          if (!response?.success) throw new Error(response?.error || "読みを取得できませんでした。");
          validateItems(missing, response.data?.items);
          const values = new Map();
          let omitted = 0;
          for (const item of missing) {
            const output = response.data.items.find(value => value.id === item.id);
            const segments = output.segments.map(({ text, reading }) => ({ text, reading }));
            const skippedCount = segments.filter(segment => !segment.reading && /[A-Za-z\p{Script=Han}]/u.test(segment.text)).length;
            omitted += skippedCount;
            values.set(item.key, { segments, skippedCount });
          }
          // APIの省略数も保持し、同じ読みを再表示したときの案内に使用する。
          if (Number.isSafeInteger(response.data?.skippedCount) && response.data.skippedCount > omitted) {
            values.get(missing[0].key).skippedCount += response.data.skippedCount - omitted;
          }
          for (const [key, value] of values) cache.set(key, value);
          return values;
        });
      for (const item of missing) {
        const promise = packet.then(values => values.get(item.key));
        inFlight.set(item.key, promise);
        const release = () => { if (inFlight.get(item.key) === promise) inFlight.delete(item.key); };
        void promise.then(release, release);
      }
    }
    await Promise.all(batch.map(item => cache.has(item.key) ? cache.get(item.key) : inFlight.get(item.key)));
  }

  function applyCachedRun(run) {
    if (run.applied || !run.items?.every(item => cache.has(item.key))) return;
    run.applied = true;
    const result = run.items.map(item => {
      const value = cache.get(item.key);
      skipped += value.skippedCount;
      return { id: item.id, segments: value.segments };
    });
    ownDOM(() => applyBatch(run.items, result));
  }

  async function refresh(id) {
    running = true;
    try {
      let batches;
      ownDOM(() => {
        restoreRecords();
        batches = makeBatches(mode === "selection" ? collectSelectionRuns() : collectRuns());
        for (const item of batches.flat()) { if (cache.has(item.key)) cacheHitCount++; }
        // 元へ戻す処理とキャッシュ表示を同じ同期処理で済ませる。
        for (const run of new Set(batches.flat().map(item => item.run))) applyCachedRun(run);
      });
      dirty = false;
      if (!batches.length) { showStatus("読みを付ける英語・漢字が見つかりませんでした。"); return; }
      for (let index = 0; index < batches.length; index++) {
        if (id !== generation || !enabled) return;
        const batch = batches[index];
        for (const run of new Set(batch.map(item => item.run))) applyCachedRun(run);
        if (batch.every(item => cache.has(item.key))) continue;
        showStatus(`読みを生成中 ${index + 1}/${batches.length}（${count}か所表示済み・APIの混雑時は待機します）`);
        await loadBatch(batch);
        if (id !== generation || !enabled || dirty) return;
        // 長い段落はすべての分割の結果がそろってからまとめて反映する。
        for (const run of new Set(batch.map(item => item.run))) applyCachedRun(run);
      }
      showStatus(`${count ? `読みを表示しました（${count}か所）` : "付与できる読みを取得できませんでした"}${skipped ? `。読みの不足・本文の変更・要素分割などで${skipped}か所を省略しました。` : ""}`);
    } catch (error) {
      if (id === generation && enabled) showStatus(`読みの生成を停止しました: ${error.message}（${count}か所表示済み）`);
    } finally {
      if (id === generation) {
        running = false;
        // 同じ本文の失敗を自動再試行せず、待機中に更新された本文だけ次に確認する。
        if (dirty && enabled) scheduleUpdate();
      }
    }
  }

  function resume() {
    if (enabled && running) return activePromise || Promise.resolve();
    clearTimeout(updateTimer);
    updateTimer = null;
    if (mode === "selection" && !records.length) {
      try { collectSelectionRuns(); }
      catch (error) { showStatus(error.message); return Promise.resolve(); }
    }
    enabled = true;
    observe();
    activePromise = refresh(++generation);
    return activePromise;
  }

  function start() {
    if (mode !== "page") {
      removeReadings();
      mode = "page";
      selectionParts = null;
    }
    return resume();
  }

  function startSelection(expectedText) {
    let selected;
    try { selected = captureSelection(expectedText); }
    catch (error) {
      // 選択取得の失敗後に「再表示」からページ全体を送信しない。
      if (!enabled && !selectionParts) mode = "selection";
      showStatus(error.message);
      return { success: false, error: error.message };
    }
    removeReadings();
    mode = "selection";
    selectionParts = selected;
    void resume();
    return { success: true };
  }

  globalThis.SarashinaReading = {
    start, startSelection, resume, remove: removeReadings,
    configure(options) { if (options?.skipElement) skipElement = options.skipElement; },
    getState() { return { running, count, skipped, enabled, mode, cachedCount: cache.size, requestCount, cacheHitCount }; }
  };
})();
