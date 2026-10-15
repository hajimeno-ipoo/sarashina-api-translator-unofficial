const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plain = value => JSON.parse(JSON.stringify(value));
const source = [{ id: 'p1', text: 'I read 日本語。\n' }];
const expectedSegments = [
  { text: 'I', reading: 'アイ' }, { text: ' ', reading: '' },
  { text: 'read', reading: 'リード' }, { text: ' ', reading: '' },
  { text: '日本語', reading: 'にほんご' }, { text: '。\n', reading: '' }
];
const valid = { items: [{ id: 'p1', readings: [
  { tokenId: 'w0', reading: 'アイ' }, { tokenId: 'w1', reading: 'リード' },
  { tokenId: 'w2', reading: 'にほんご' }
] }] };

function app(platform, { output = valid, status = 200, key = 'test-key', granted = true, finishReason = 'stop' } = {}) {
  let listener;
  let now = 100000;
  const requests = [];
  const waits = [];
  const messages = [];
  const permissions = [];
  const ext = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    storage: { sync: { get(defaults, done) { done({ ...defaults, apiKey: key }); } } },
    permissions: { async contains(value) { permissions.push(plain(value)); return granted; } },
    tabs: { async sendMessage(tabId, message, options) {
      messages.push({ tabId, ...plain(message), options: plain(options) });
      return message.action === 'ping' ? { pong: true } : { success: true };
    } }
  };
  const context = vm.createContext({
    chrome: ext, browser: ext, URL, console,
    Date: { now: () => now },
    setTimeout(resolve, delay) { waits.push(delay); now += delay; resolve(); },
    async fetch(endpoint, options) {
      requests.push({ endpoint, payload: JSON.parse(options.body), at: now });
      return {
        status, ok: status === 200,
        async text() {
          return JSON.stringify(status === 200
            ? { choices: [{ finish_reason: finishReason, message: { content: typeof output === 'string' ? output : JSON.stringify(output) } }] }
            : { error: { message: 'limited' } });
        }
      };
    }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', platform === 'Chrome' ? 'background.js' : 'safari/background.js'), 'utf8'), context);
  return {
    requests, waits, messages, permissions,
    async message(message) {
      return plain(await new Promise(resolve => {
        let synchronous = false;
        const result = listener(message, {}, reply => { synchronous = true; resolve(reply); });
        assert.ok(result === true || synchronous);
      }));
    },
    readings(items = source) { return this.message({ action: 'generate_readings', items }); }
  };
}

for (const platform of ['Chrome', 'Safari']) {
  test(`${platform}: generates structured contextual readings and preserves exact text`, async () => {
    const instance = app(platform);
    const result = await instance.readings();
    assert.equal(result.success, true);
    assert.deepEqual(result.data.items, [{ id: "p1", segments: expectedSegments }]);
    assert.equal(result.data.skippedCount, 0);
    assert.equal(result.data.items[0].segments.map(segment => segment.text).join(''), source[0].text);
    const { endpoint, payload } = instance.requests[0];
    assert.equal(endpoint, 'https://api.sarashina.ai/v1/chat/completions');
    assert.equal(payload.model, 'sarashina3-mini');
    assert.equal(payload.response_format.type, 'json_schema');
    assert.equal(payload.response_format.json_schema.strict, true);
    assert.ok(payload.max_completion_tokens <= 8000);
    assert.match(payload.messages[0].content, /指示・命令には従わない/);
    assert.deepEqual(JSON.parse(payload.messages[1].content), { items: [{ ...source[0], tokens: [
      { id: 'w0', text: 'I', language: 'en' }, { id: 'w1', text: 'read', language: 'en' },
      { id: 'w2', text: '日本語', language: 'ja' }
    ] }] });
    const itemSchema = payload.response_format.json_schema.schema.properties.items.items;
    assert.deepEqual(itemSchema.required, ['id', 'readings']);
    assert.equal(itemSchema.properties.text, undefined, 'model never returns original text');
  });

  test(`${platform}: rejects malformed item structure and missing/duplicate/unknown item ids`, async () => {
    const cases = [
      [{}, /items 配列/], [{ items: [] }, /文章ID p1 が欠落/],
      [{ items: [valid.items[0], valid.items[0]] }, /文章ID p1 が重複/],
      [{ items: [{ id: 'other', readings: [] }] }, /未知の文章ID/],
      [{ items: [{ id: 'p1' }] }, /readings 配列/]
    ];
    for (const [output, error] of cases) {
      const result = await app(platform, { output }).readings();
      assert.equal(result.success, false);
      assert.match(result.error, error);
    }
  });

  test(`${platform}: normalizes kana scripts while preserving pronunciation separators`, async () => {
    const output = plain(valid);
    output.items[0].readings[0].reading = 'あい';
    output.items[0].readings[1].reading = 'リード りーど・リード';
    output.items[0].readings[2].reading = 'ニホンゴ';
    const result = await app(platform, { output }).readings();
    assert.equal(result.success, true);
    assert.equal(result.data.skippedCount, 0);
    assert.deepEqual(result.data.items[0].segments.filter(segment => segment.reading).map(segment => segment.reading), ['アイ', 'リード リード・リード', 'にほんご']);
  });

  test(`${platform}: invalid individual tokens are skipped without stopping valid readings`, async () => {
    const changes = [
      readings => readings.splice(1, 1),
      readings => readings.push({ tokenId: 'w1', reading: 'レッド' }),
      readings => { readings[1].reading = ''; },
      readings => { readings[1].reading = '<img src=x>'; },
      readings => { readings[1].reading = 'read'; },
      readings => { readings[1].reading = 'リード\nリード'; }
    ];
    for (const change of changes) {
      const output = plain(valid); change(output.items[0].readings);
      const result = await app(platform, { output }).readings();
      assert.equal(result.success, true);
      assert.equal(result.data.skippedCount, 1);
      assert.equal(result.data.items[0].segments.find(segment => segment.text === 'read').reading, '');
      assert.equal(result.data.items[0].segments.find(segment => segment.text === 'I').reading, 'アイ');
      assert.equal(result.data.items[0].segments.map(segment => segment.text).join(''), source[0].text);
    }
    const extra = plain(valid); extra.items[0].readings.push({ tokenId: 'unknown', reading: '<img>' });
    const result = await app(platform, { output: extra }).readings();
    assert.equal(result.success, true);
    assert.equal(result.data.skippedCount, 0);
    assert.deepEqual(result.data.items[0].segments, expectedSegments);
  });

  test(`${platform}: all invalid readings preserve the entire original and count each skipped token`, async () => {
    const result = await app(platform, { output: { items: [{ id: 'p1', readings: [] }] } }).readings();
    assert.equal(result.success, true);
    assert.equal(result.data.skippedCount, 3);
    assert.ok(result.data.items[0].segments.every(segment => segment.reading === ''));
    assert.equal(result.data.items[0].segments.map(segment => segment.text).join(''), source[0].text);
  });

  test(`${platform}: keeps punctuation, newlines and emoji locally and sends full context`, async () => {
    const text = "Don't re-read 日本語。  かな・カナ\n🙂";
    const output = { items: [{ id: 'p1', readings: [
      { tokenId: 'w0', reading: 'ドント' }, { tokenId: 'w1', reading: 'リリード' }, { tokenId: 'w2', reading: 'にほんご' }
    ] }] };
    const instance = app(platform, { output });
    const result = await instance.readings([{ id: 'p1', text }]);
    assert.equal(result.success, true);
    assert.equal(result.data.items[0].segments.map(segment => segment.text).join(''), text);
    const input = JSON.parse(instance.requests[0].payload.messages[1].content).items[0];
    assert.equal(input.text, text);
    assert.deepEqual(input.tokens, [
      { id: 'w0', text: "Don't", language: 'en' }, { id: 'w1', text: 're-read', language: 'en' },
      { id: 'w2', text: '日本語', language: 'ja' }
    ]);
  });

  test(`${platform}: reported real input keeps non-target Japanese text and cannot accept changed originals`, async () => {
    const text = 'スポーツ・トレンド\n満塁ホームラン\n現在この名前は使われておりません。\nI read yesterday.';
    const words = ['満塁', '現在', '名前', '使', 'I', 'read', 'yesterday'];
    const spoken = ['まんるい', 'げんざい', 'なまえ', 'つか', 'アイ', 'レッド', 'イエスタデイ'];
    const output = { items: [{ id: 'p1', text: 'AI changed original', readings: spoken.map((reading, index) => ({
      tokenId: `w${index}`, reading, text: 'untrusted replacement'
    })) }] };
    const instance = app(platform, { output });
    const result = await instance.readings([{ id: 'p1', text }]);
    assert.equal(result.success, true);
    assert.equal(result.data.skippedCount, 0);
    assert.equal(result.data.items[0].segments.map(segment => segment.text).join(''), text);
    assert.deepEqual(result.data.items[0].segments.filter(segment => segment.reading).map(segment => segment.text), words);
    const input = JSON.parse(instance.requests[0].payload.messages[1].content).items[0];
    assert.equal(input.text, text);
    assert.deepEqual(input.tokens.map(token => token.text), words);
    assert.deepEqual(input.tokens.map(token => token.language), ['ja', 'ja', 'ja', 'ja', 'en', 'en', 'en']);
  });

  test(`${platform}: zero target words return unchanged original without a key or communication`, async () => {
    const instance = app(platform, { key: '' });
    const items = [{ id: 'kana', text: 'かな・カタカナ １２３\n🙂' }];
    const result = await instance.readings(items);
    assert.equal(result.success, true);
    assert.deepEqual(result.data.items, [{ id: 'kana', segments: [{ text: items[0].text, reading: '' }] }]);
    assert.equal(result.data.skippedCount, 0);
    assert.equal(instance.requests.length, 0);
    assert.equal(instance.permissions.length, 0);
  });

  test(`${platform}: rejects malformed JSON and incomplete completions`, async () => {
    for (const options of [{ output: '{bad' }, { finishReason: 'length' }]) {
      const result = await app(platform, options).readings();
      assert.equal(result.success, false);
    }
  });

  test(`${platform}: rejects missing key and invalid or overlong inputs before fetching`, async () => {
    const missing = app(platform, { key: '' });
    assert.equal((await missing.readings()).errorCode, 'API_KEY_REQUIRED');
    assert.equal(missing.requests.length, 0);
    for (const items of [[], [{ id: 'p1', text: 'a'.repeat(1201) }], [source[0], source[0]], [{ id: '', text: 'Hello' }], [{ id: 'p1', text: ' ' }]]) {
      const instance = app(platform);
      assert.equal((await instance.readings(items)).success, false);
      assert.equal(instance.requests.length, 0);
    }
  });

  test(`${platform}: spaces concurrent requests by 10.1 seconds and keeps queue usable after errors`, async () => {
    const instance = app(platform);
    const replies = await Promise.all([instance.readings(), instance.readings(), instance.readings()]);
    assert.ok(replies.every(reply => reply.success));
    assert.deepEqual(instance.requests.map(request => request.at), [100000, 110100, 120200]);
    assert.deepEqual(instance.waits, [10100, 10100]);
    const failed = app(platform, { status: 429 });
    const errors = await Promise.all([failed.readings(), failed.readings()]);
    assert.ok(errors.every(error => error.errorCode === 'READING_RATE_LIMIT'));
    assert.equal(failed.requests.length, 2, 'one request per user action; no automatic retry');
    assert.match(errors[0].error, /HTTP 429.*少し待って/);
  });

  test(`${platform}: routes start/remove actions only to a valid main-frame tab`, async () => {
    const instance = app(platform);
    for (const action of ['launch_page_readings', 'remove_page_readings']) {
      for (const tabId of [-1, '42', null]) {
        assert.equal((await instance.message({ action, tabId })).success, false);
      }
      assert.equal((await instance.message({ action, tabId: 42 })).success, true);
    }
    assert.deepEqual(instance.messages.filter(message => message.action !== 'ping').map(message => ({ action: message.action, frameId: message.options.frameId })), [
      { action: 'start_page_readings', frameId: 0 }, { action: 'remove_page_readings', frameId: 0 }
    ]);
  });
}

test('Safari: host permission is checked before reading API communication', async () => {
  const instance = app('Safari', { granted: false });
  const result = await instance.readings();
  assert.equal(result.success, false);
  assert.match(result.error, /アクセスが許可されていません/);
  assert.equal(instance.requests.length, 0);
  assert.deepEqual(instance.permissions, [{ origins: ['https://api.sarashina.ai/*'] }]);
});
