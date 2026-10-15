const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

// Uses an existing Playwright installation. No browser or dependency is downloaded.
const playwright = require(process.env.PLAYWRIGHT_MODULE
  || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/reading.html'), 'utf8');
const readingScript = path.join(__dirname, '..', 'reading.js');
const engines = (process.env.READING_TEST_BROWSERS || 'chromium').split(',');

function bounded(promise, operation) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${operation} timed out after 15 seconds`)), 15000); })
  ]).finally(() => clearTimeout(timer));
}

async function setup(browser, mode = 'normal', existingPage = null) {
  const page = existingPage || await bounded(browser.newPage(), 'create fixture page');
  page.setDefaultTimeout(15000);
  await page.setContent(fixture);
  await page.evaluate((responseMode) => {
    window.mockMode = responseMode;
    window.readingRequests = [];
    window.replyWaiters = [];
    window.makeReadingResponse = (request) => ({
      success: true,
      data: { items: request.items.map(({ id, text }) => {
        const readings = {
          English: 'イングリッシュ', 勉強: 'べんきょう', 今日: 'きょう', 日本語: 'にほんご',
          読: 'よ', I: 'アイ', read: text.includes('yesterday') ? 'レッド' : 'リード',
          yesterday: 'イエスタデイ', every: 'エブリ', day: 'デイ', 人気: 'ひとけ',
          道: 'みち', 歩: 'ある', Visit: 'ビジット', and: 'アンド', A: 'ア',
          reading: 'リーディング', test: 'テスト', Read: 'リード', The: 'ザ',
          destination: 'デスティネーション', Original: 'オリジナル',
          New: 'ニュー', Updated: 'アップデーテッド', tomorrow: 'トゥモロー'
        };
        const segments = [];
        const pattern = /[A-Za-z]+|日本語|勉強|今日|人気|[読道歩]/g;
        let offset = 0;
        for (const match of text.matchAll(pattern)) {
          if (match.index > offset) segments.push({ text: text.slice(offset, match.index), reading: '' });
          segments.push({ text: match[0], reading: readings[match[0]] || '' });
          offset = match.index + match[0].length;
        }
        if (offset < text.length) segments.push({ text: text.slice(offset), reading: '' });
        return { id, segments };
      }) }
    });
    window.contentListeners = [];
    window.chrome = { runtime: { onMessage: { addListener: (listener) => window.contentListeners.push(listener) }, sendMessage: async (request) => {
      if (request.action === 'translate') return {
        success: true,
        data: { translatedText: request.text.split('\n').map((line) => line.replace(/^(\[\d+\]) .*/, '$1 日本語')).join('\n') }
      };
      if (request.action !== 'generate_readings') throw new Error(`Unexpected action: ${request.action}`);
      window.readingRequests.push(request);
      if (window.mockMode === 'deferred') return new Promise((resolve) => window.replyWaiters.push(() => resolve(window.makeReadingResponse(request))));
      if (window.mockMode === 'deferred-error') return new Promise((resolve) => window.replyWaiters.push(() => resolve({ success: false, error: 'Mock stale request failed' })));
      if (window.mockMode === 'error') return { success: false, error: 'Mock service unavailable' };
      if (window.mockMode === 'invalid') return {
        success: true, data: { items: request.items.map(({ id }) => ({ id, segments: [{ text: 'changed original', reading: 'かいざん' }] })) }
      };
      const response = window.makeReadingResponse(request);
      if (window.mockMode === 'html') {
        for (const item of response.data.items) {
          for (const segment of item.segments) {
            if (segment.reading) segment.reading = '<img src=x onerror="window.injected=true">';
          }
        }
      }
      return response;
    } } };
    window.beforeArticle = document.getElementById('article').innerHTML;
    window.beforeExcluded = document.getElementById('excluded').innerHTML;
  }, mode);
  await page.addScriptTag({ path: readingScript });
  // Production configures shared icon exclusions from content.js.
  await page.addScriptTag({ path: path.join(__dirname, '..', 'content.js') });
  return page;
}

async function beginDeferred(page) {
  await page.evaluate(() => { window.pendingReading = SarashinaReading.start().catch((error) => ({ error: error.message })); });
  await page.waitForFunction(() => window.replyWaiters.length > 0);
}

async function finishDeferred(page) {
  await page.evaluate(async () => {
    window.mockMode = 'normal';
    window.replyWaiters.splice(0).forEach((resolve) => resolve());
    await window.pendingReading;
  });
}

async function requestCount(page) {
  return page.evaluate(() => readingRequests.length);
}

async function sentAfter(page, index) {
  return page.evaluate((offset) => readingRequests.slice(offset).flatMap(({ items }) => items.map(({ text }) => text)), index);
}

async function expectNoNewRequests(page, before, milliseconds = 1400) {
  // An absence assertion needs an observation window spanning two 600 ms debounces.
  await page.evaluate((duration) => new Promise((resolve) => setTimeout(resolve, duration)), milliseconds);
  assert.equal(await requestCount(page), before);
}

for (const engine of engines) {
  test(`${engine}: reading DOM behavior (mock AI; no live accuracy assertion)`, { timeout: 120000 }, async (t) => {
    const executablePath = process.env[`READING_${engine.toUpperCase()}_EXECUTABLE`];
    const browser = await playwright[engine].launch({ headless: true, timeout: 15000, ...(executablePath ? { executablePath } : {}) });
    t.after(() => bounded(browser.close(), 'close test browser'));

    await t.test('context, mixed languages, inline markup, clicks and exact restoration', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        const applied = await page.evaluate(() => {
          const pairs = (selector) => [...document.querySelectorAll(`${selector} ruby`)].map((ruby) => ({
            text: [...ruby.childNodes].filter((node) => node.nodeName !== 'RT' && node.nodeName !== 'RP').map((node) => node.textContent).join(''),
            reading: ruby.querySelector('rt')?.textContent
          }));
          return {
            mixed: pairs('#mixed'), past: pairs('#past'), present: pairs('#present'), context: pairs('#context'),
            inline: pairs('#inline'), button: pairs('#original-button'), split: pairs('#split'),
            sameElements: originalLink === document.getElementById('original-link')
              && originalButton === document.getElementById('original-button')
              && originalBold === document.getElementById('original-bold'),
            excluded: document.getElementById('excluded').innerHTML === beforeExcluded,
            requests: readingRequests, state: SarashinaReading.getState(),
            rubyPosition: getComputedStyle(document.querySelector('#mixed ruby')).rubyPosition
          };
        });
        assert.ok(applied.mixed.some(({ text, reading }) => text === 'English' && reading === 'イングリッシュ'));
        assert.ok(applied.mixed.some(({ text, reading }) => text === '日本語' && reading === 'にほんご'));
        assert.ok(applied.past.some(({ text, reading }) => text === 'read' && reading === 'レッド'));
        assert.ok(applied.present.some(({ text, reading }) => text === 'read' && reading === 'リード'));
        assert.ok(applied.context.some(({ text, reading }) => text === '人気' && reading === 'ひとけ'));
        assert.ok(applied.inline.length > 0 && applied.button.length > 0);
        assert.equal(applied.split.some(({ text }) => text === 'reading'), false, 'do not attach one reading across different original elements');
        assert.equal(applied.sameElements, true);
        assert.equal(applied.excluded, true);
        assert.ok(applied.state.count > 0);
        assert.equal(applied.state.running, false);
        assert.notEqual(applied.rubyPosition, 'under');
        const sentText = applied.requests.flatMap(({ items }) => items.map(({ text }) => text)).join('\n');
        assert.match(sentText, /I read yesterday\./);
        assert.match(sentText, /人気のない道を歩く/);
        assert.doesNotMatch(sentText, /<\/?(?:strong|b|a|script)\b/i);
        assert.doesNotMatch(sentText, /Input|Textarea|Editable|Preformatted|Code|既存|settings|Hiddenattribute|Displaynone|Visibilityhidden|Option/);
        if (process.env.READING_SCREENSHOT && engine === 'chromium') {
          await page.screenshot({ path: process.env.READING_SCREENSHOT, fullPage: true });
        }
        await page.click('#original-link');
        await page.click('#original-button');
        assert.deepEqual(await page.evaluate(() => [linkClicks, buttonClicks]), [1, 1]);
        await page.evaluate(() => SarashinaReading.remove());
        assert.deepEqual(await page.evaluate(() => ({
          restored: document.getElementById('article').innerHTML === beforeArticle,
          sameLink: originalLink === document.getElementById('original-link'),
          sameButton: originalButton === document.getElementById('original-button'),
          count: SarashinaReading.getState().count
        })), { restored: true, sameLink: true, sameButton: true, count: 0 });
        await page.click('#original-link');
        await page.click('#original-button');
        assert.deepEqual(await page.evaluate(() => [linkClicks, buttonClicks]), [2, 2]);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('a site update while AI is pending is preserved', async () => {
      const page = await setup(browser, 'deferred');
      try {
        await beginDeferred(page);
        await page.evaluate(() => { document.getElementById('changing').textContent = 'Site changed this text.'; });
        await finishDeferred(page);
        assert.deepEqual(await page.evaluate(() => ({
          text: document.getElementById('changing').textContent,
          ruby: document.querySelectorAll('#changing ruby').length
        })), { text: 'Site changed this text.', ruby: 0 });
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.textContent('#changing'), 'Site changed this text.');
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('removal preserves site updates made after readings were applied', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        await page.evaluate(() => {
          document.getElementById('changing').textContent = 'New site text.';
          const ruby = document.querySelector('#mixed ruby');
          ruby.firstChild.nodeValue = 'Updated';
        });
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.textContent('#changing'), 'New site text.');
        assert.match(await page.textContent('#mixed'), /^Updatedを勉強する/);
        assert.equal(await page.locator('#article ruby').count(), 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('a long single TextNode receives readings through its final section in bounded requests', async () => {
      const page = await setup(browser);
      try {
        const text = 'English 日本語. '.repeat(260) + 'Last 日本語.';
        await page.evaluate((original) => {
          document.body.replaceChildren();
          const paragraph = document.createElement('p');
          paragraph.id = 'long';
          paragraph.textContent = original;
          document.body.append(paragraph);
        }, text);
        await page.evaluate(() => SarashinaReading.start());
        const result = await page.evaluate(() => ({
          requests: readingRequests,
          readings: [...document.querySelectorAll('#long ruby')].map((ruby) => ruby.querySelector('rt').textContent),
          finalRuby: document.querySelector('#long').lastChild.previousSibling?.nodeName
        }));
        assert.ok(result.requests.length > 1);
        assert.equal(result.requests.flatMap(({ items }) => items.map(({ text }) => text)).join(''), text);
        assert.ok(result.requests.every(({ items }) => items.reduce((total, item) => total + item.text.length, 0) <= 1200));
        assert.equal(result.readings.length, 521);
        assert.equal(result.readings.at(-1), 'にほんご');
        assert.equal(result.finalRuby, 'RUBY');
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.textContent('#long'), text);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('translation then readings then the original-page button restores the complete article', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => contentListeners.forEach((listener) => listener({ action: 'start_page_translation', direction: 'en_to_ja' }, {}, () => {})));
        await page.waitForFunction(() => document.getElementById('sarashina-page-bar-container')?.shadowRoot.textContent.includes('翻訳完了'));
        assert.equal(await page.textContent('#changing'), '日本語');
        await page.evaluate(() => SarashinaReading.start());
        assert.ok(await page.locator('#article ruby').count() > 0);
        await page.evaluate(() => document.getElementById('sarashina-page-bar-container').shadowRoot.getElementById('sarashina-restore-btn').click());
        assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
        assert.equal(await page.locator('#article ruby').count(), 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('starting page translation cancels a pending reading response', async () => {
      const page = await setup(browser, 'deferred');
      try {
        await beginDeferred(page);
        await page.evaluate(() => contentListeners.forEach((listener) => listener({ action: 'start_page_translation', direction: 'en_to_ja' }, {}, () => {})));
        await page.waitForFunction(() => document.getElementById('sarashina-page-bar-container')?.shadowRoot.textContent.includes('翻訳完了'));
        await finishDeferred(page);
        assert.equal(await page.locator('#article ruby').count(), 0);
        assert.equal(await page.textContent('#changing'), '日本語');
        await page.evaluate(() => document.getElementById('sarashina-page-bar-container').shadowRoot.getElementById('sarashina-restore-btn').click());
        assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('remove cancels late responses and allows a fresh run', async () => {
      const page = await setup(browser, 'deferred');
      try {
        await beginDeferred(page);
        await page.evaluate(() => SarashinaReading.remove());
        await finishDeferred(page);
        assert.equal(await page.locator('#article ruby').count(), 0);
        assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
        await page.evaluate(() => SarashinaReading.start());
        assert.ok(await page.locator('#article ruby').count() > 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('repeated starts never duplicate an active or completed run', async () => {
      const page = await setup(browser, 'deferred');
      try {
        await beginDeferred(page);
        const pendingCalls = await page.evaluate(() => readingRequests.length);
        await page.evaluate(() => { window.secondReading = SarashinaReading.start(); });
        assert.equal(await page.evaluate(() => readingRequests.length), pendingCalls);
        await finishDeferred(page);
        const before = await page.locator('#article ruby').count();
        const calls = await page.evaluate(() => readingRequests.length);
        await page.evaluate(() => SarashinaReading.start());
        assert.equal(await page.locator('#article ruby').count(), before);
        assert.equal(await page.locator('ruby ruby').count(), 0);
        assert.equal(await page.evaluate(() => readingRequests.length), calls);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('hide then show reuses readings without another API request or observer loop', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        const requests = await requestCount(page);
        const rubies = await page.locator('#article ruby').count();
        await expectNoNewRequests(page, requests);
        assert.equal(await page.locator('#article ruby').count(), rubies);
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.locator('#article ruby').count(), 0);
        await page.evaluate(() => SarashinaReading.start());
        assert.equal(await page.locator('#article ruby').count(), rubies);
        assert.equal(await requestCount(page), requests);
        await expectNoNewRequests(page, requests);
        assert.equal(await page.locator('ruby ruby').count(), 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('the page bar keeps a redisplay button and restores cached readings without another request', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        const before = await requestCount(page);
        const rubies = await page.locator('#article ruby').count();
        assert.ok(rubies > 0);
        await page.evaluate(() => { window.originalReadingBar = document.getElementById('sarashina-reading-bar'); });

        await page.getByRole('button', { name: '読みを外す', exact: true }).click();
        assert.equal(await page.locator('#article ruby').count(), 0);
        assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
        assert.equal(await page.evaluate(() => originalReadingBar === document.getElementById('sarashina-reading-bar')), true);
        assert.equal(await page.getByRole('button', { name: '再表示', exact: true }).isVisible(), true);
        await expectNoNewRequests(page, before);

        await page.getByRole('button', { name: '再表示', exact: true }).click();
        await page.waitForFunction(() => !SarashinaReading.getState().running && SarashinaReading.getState().count > 0);
        assert.equal(await page.locator('#article ruby').count(), rubies);
        assert.equal(await page.getByRole('button', { name: '読みを外す', exact: true }).isVisible(), true);
        await expectNoNewRequests(page, before);

        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.locator('#sarashina-reading-bar').count(), 0, 'programmatic remove still removes the controls');
        assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('hidden updates make no requests and showing sends only the changed paragraph', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        await page.evaluate(() => SarashinaReading.remove());
        const before = await requestCount(page);
        await page.evaluate(() => { document.getElementById('changing').textContent = 'New English paragraph.'; });
        await expectNoNewRequests(page, before);
        await page.evaluate(() => SarashinaReading.start());
        assert.deepEqual(await sentAfter(page, before), ['New English paragraph.']);
        assert.ok(await page.locator('#changing ruby').count() > 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('a visible new paragraph is processed automatically without resending the old page', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        const before = await requestCount(page);
        await page.evaluate(() => {
          const paragraph = document.createElement('p');
          paragraph.id = 'appended';
          paragraph.textContent = 'New English paragraph.';
          document.getElementById('article').append(paragraph);
        });
        await page.waitForFunction(() => document.querySelector('#appended ruby') && !SarashinaReading.getState().running);
        assert.deepEqual(await sentAfter(page, before), ['New English paragraph.']);
        await expectNoNewRequests(page, await requestCount(page));
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('React-style replacement reuses identical context and requests a changed context only', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        const before = await requestCount(page);
        await page.evaluate(() => {
          const replacement = document.createElement('p');
          replacement.id = 'changing';
          replacement.textContent = 'Original English.';
          document.getElementById('changing').replaceWith(replacement);
        });
        await page.waitForFunction(() => document.querySelector('#changing ruby') && !SarashinaReading.getState().running);
        assert.equal(await requestCount(page), before);
        await page.evaluate(() => {
          const replacement = document.createElement('p');
          replacement.id = 'changing';
          replacement.textContent = 'Updated English context.';
          document.getElementById('changing').replaceWith(replacement);
        });
        await page.waitForFunction(() => readingRequests.some(({ items }) => items.some(({ text }) => text === 'Updated English context.'))
          && document.querySelector('#changing ruby') && !SarashinaReading.getState().running);
        assert.deepEqual(await sentAfter(page, before), ['Updated English context.']);
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.textContent('#changing'), 'Updated English context.');
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('the same word is requested again when its surrounding context changes', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        const before = await requestCount(page);
        await page.evaluate(() => { document.getElementById('past').textContent = 'I read tomorrow.'; });
        await page.waitForFunction(() => [...document.querySelectorAll('#past ruby')].some((ruby) => ruby.firstChild.textContent === 'read'
          && ruby.querySelector('rt')?.textContent === 'リード') && !SarashinaReading.getState().running);
        assert.deepEqual(await sentAfter(page, before), ['I read tomorrow.']);
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.textContent('#past'), 'I read tomorrow.');
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('a change during an API request rejects old readings and follows the latest sentence', async () => {
      const page = await setup(browser, 'deferred');
      try {
        await beginDeferred(page);
        const before = await requestCount(page);
        await page.evaluate(() => {
          document.getElementById('past').textContent = 'I read tomorrow.';
          window.staleReadings = [];
          window.staleObserver = new MutationObserver(() => {
            if ([...document.querySelectorAll('#past ruby')].some((ruby) => ruby.querySelector('rt')?.textContent === 'レッド')) {
              window.staleReadings.push('past tense reading applied to changed future context');
            }
          });
          window.staleObserver.observe(document.getElementById('past'), { childList: true, characterData: true, subtree: true });
        });
        await finishDeferred(page);
        await page.waitForFunction(() => [...document.querySelectorAll('#past ruby')].some((ruby) => ruby.firstChild.textContent === 'read'
          && ruby.querySelector('rt')?.textContent === 'リード') && !SarashinaReading.getState().running);
        assert.deepEqual(await page.evaluate(() => staleReadings), []);
        assert.deepEqual(await sentAfter(page, before), ['I read tomorrow.']);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('a response received while hidden is cached and never displayed until show', async () => {
      const page = await setup(browser, 'deferred');
      try {
        await beginDeferred(page);
        const before = await requestCount(page);
        await page.evaluate(() => SarashinaReading.remove());
        await finishDeferred(page);
        await expectNoNewRequests(page, before);
        assert.equal(await page.locator('#article ruby').count(), 0);
        assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
        await page.evaluate(() => SarashinaReading.start());
        assert.ok(await page.locator('#article ruby').count() > 0);
        assert.equal(await requestCount(page), before);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('a failed stale request follows a real pending text change once without a retry loop', async () => {
      const page = await setup(browser, 'deferred-error');
      try {
        await beginDeferred(page);
        const before = await requestCount(page);
        await page.evaluate(() => { document.getElementById('past').textContent = 'I read tomorrow.'; });
        await finishDeferred(page);
        await page.waitForFunction(() => [...document.querySelectorAll('#past ruby')].some((ruby) => ruby.firstChild.textContent === 'read'
          && ruby.querySelector('rt')?.textContent === 'リード') && !SarashinaReading.getState().running);
        assert.equal(await requestCount(page), before + 1, 'a real change schedules one latest-page request after the old failure');
        const latest = await sentAfter(page, before);
        assert.ok(latest.includes('I read tomorrow.'));
        assert.equal(latest.includes('I read yesterday.'), false);
        await expectNoNewRequests(page, before + 1);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('hide immediately followed by show shares the existing in-flight request', async () => {
      const page = await setup(browser, 'deferred');
      try {
        await beginDeferred(page);
        const before = await requestCount(page);
        await page.evaluate(() => {
          SarashinaReading.remove();
          window.reopenedReading = SarashinaReading.start();
        });
        await expectNoNewRequests(page, before);
        await finishDeferred(page);
        await page.evaluate(() => window.reopenedReading);
        await page.waitForFunction(() => SarashinaReading.getState().count > 0 && !SarashinaReading.getState().running);
        assert.equal(await requestCount(page), before);
        assert.equal(await page.locator('ruby ruby').count(), 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('API failure never triggers an endless observer retry loop', async () => {
      const page = await setup(browser, 'error');
      try {
        await page.evaluate(() => SarashinaReading.start());
        const before = await requestCount(page);
        assert.ok(before > 0);
        await expectNoNewRequests(page, before, 2000);
        assert.equal(await page.locator('#article ruby').count(), 0);
        assert.equal(await page.evaluate(() => SarashinaReading.getState().running), false);
        await page.evaluate(() => { window.mockMode = 'normal'; });
        await page.evaluate(() => SarashinaReading.start());
        assert.ok(await page.locator('#article ruby').count() > 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('an edited ruby is cleaned up without restoring old text', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        const before = await requestCount(page);
        await page.evaluate(() => { document.querySelector('#changing ruby').firstChild.nodeValue = 'Updated'; });
        await page.waitForFunction(() => readingRequests.some(({ items }) => items.some(({ text }) => text === 'Updated English.'))
          && !SarashinaReading.getState().running);
        assert.deepEqual(await sentAfter(page, before), ['Updated English.']);
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.textContent('#changing'), 'Updated English.');
        assert.equal(await page.locator('#changing ruby').count(), 0);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('a new document has an empty cache and sends its own request', async () => {
      const page = await setup(browser);
      try {
        await page.evaluate(() => SarashinaReading.start());
        assert.ok(await requestCount(page) > 0);
        await page.reload();
        assert.equal(await page.evaluate(() => typeof globalThis.SarashinaReading), 'undefined');
        await setup(browser, 'normal', page);
        assert.equal(await requestCount(page), 0);
        await page.evaluate(() => SarashinaReading.start());
        assert.ok(await requestCount(page) > 0);
        assert.ok(await page.locator('#article ruby').count() > 0);
      } finally { await bounded(page.close(), 'close reloaded fixture page'); }
    });

    await t.test('API errors and mismatched originals leave text intact and can recover', async () => {
      for (const mode of ['error', 'invalid']) {
        const page = await setup(browser, mode);
        try {
          await page.evaluate(() => SarashinaReading.start().catch(() => {}));
          assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
          assert.equal(await page.evaluate(() => SarashinaReading.getState().running), false);
          await page.evaluate(() => { SarashinaReading.remove(); window.mockMode = 'normal'; });
          await page.evaluate(() => SarashinaReading.start());
          assert.ok(await page.locator('#article ruby').count() > 0);
        } finally { await bounded(page.close(), 'close fixture page'); }
      }
    });

    await t.test('HTML-looking readings cannot create executable DOM', async () => {
      const page = await setup(browser, 'html');
      try {
        await page.evaluate(() => SarashinaReading.start().catch(() => {}));
        assert.equal(await page.locator('#article img, #article script').count(), 0);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        await page.evaluate(() => SarashinaReading.remove());
        assert.equal(await page.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
      } finally { await bounded(page.close(), 'close fixture page'); }
    });

    await t.test('both popup buttons route through actual background and content handlers', async () => {
      const contentPage = await setup(browser);
      const popup = await bounded(browser.newPage(), 'create popup page');
      try {
        let backgroundListener;
        const routed = [];
        const chrome = {
          runtime: {
            onInstalled: { addListener() {} },
            onMessage: { addListener(listener) { backgroundListener = listener; } }
          },
          contextMenus: { onClicked: { addListener() {} } },
          commands: { onCommand: { addListener() {} } },
          tabs: { sendMessage: async (tabId, message, options) => {
            routed.push({ tabId, message, options });
            return contentPage.evaluate((data) => new Promise((resolve) => {
              for (const listener of window.contentListeners) listener(data, {}, resolve);
            }), message);
          } }
        };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), {
          chrome, console, URL, setTimeout, clearTimeout
        }, { filename: 'background.js' });
        await popup.exposeFunction('bridgeToBackground', (message) => new Promise((resolve) => {
          backgroundListener(message, {}, resolve);
        }));
        const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8').replace(/<script[^>]*src="popup\.js"[^>]*><\/script>/, '');
        await popup.setContent(popupHtml);
        await popup.evaluate(() => {
          window.closedByPopup = 0;
          window.close = () => { window.closedByPopup++; };
          window.chrome = {
            storage: { sync: { get: (_keys, callback) => callback({ apiKey: 'mock-key' }) } },
            tabs: { query: async () => [{ id: 42, url: 'https://fixture.example/' }] },
            runtime: { sendMessage: (message) => window.bridgeToBackground(message) }
          };
        });
        await popup.addScriptTag({ path: path.join(__dirname, '..', 'popup.js') });
        await popup.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
        await popup.click('#show-readings-btn');
        await contentPage.waitForFunction(() => !SarashinaReading.getState().running && SarashinaReading.getState().count > 0);
        await popup.waitForFunction(() => window.closedByPopup === 1);
        await popup.click('#remove-readings-btn');
        await popup.waitForFunction(() => window.closedByPopup === 2);
        assert.equal(await contentPage.locator('#article ruby').count(), 0);
        assert.equal(await contentPage.evaluate(() => document.getElementById('article').innerHTML === beforeArticle), true);
        assert.deepEqual(routed.map(({ tabId, message, options }) => ({ tabId, action: message.action, frameId: options.frameId })), [
          { tabId: 42, action: 'ping', frameId: 0 },
          { tabId: 42, action: 'start_page_readings', frameId: 0 },
          { tabId: 42, action: 'ping', frameId: 0 },
          { tabId: 42, action: 'remove_page_readings', frameId: 0 }
        ]);
      } finally {
        await Promise.all([
          bounded(contentPage.close(), 'close fixture page'),
          bounded(popup.close(), 'close popup page')
        ]);
      }
    });
  });
}
