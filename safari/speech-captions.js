const captionSentences = new Intl.Segmenter("ja", { granularity: "sentence" });
const captionWords = new Intl.Segmenter("ja", { granularity: "word" });
const MAX_CAPTION_LENGTH = 32;
const MIN_CAPTION_LENGTH = 8;
const SPEECH_RATE_WINDOW_MS = 60000;
const SPEECH_REQUESTS_PER_WINDOW = 6;
const SPEECH_WAIT_STEP_MS = 20000;
const speechRequestTimes = [];
let speechRetryAt = 0;

async function waitForSpeechSlot(signal) {
  while (true) {
    signal.throwIfAborted();
    const now = Date.now();
    while (speechRequestTimes[0] <= now - SPEECH_RATE_WINDOW_MS) speechRequestTimes.shift();
    const nextSlot = speechRequestTimes.length < SPEECH_REQUESTS_PER_WINDOW
      ? now
      : speechRequestTimes[0] + SPEECH_RATE_WINDOW_MS;
    const wait = Math.max(nextSlot, speechRetryAt) - now;
    if (wait <= 0) {
      speechRequestTimes.push(now);
      return;
    }

    await new Promise((resolve, reject) => {
      let timer;
      const cancelWait = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancelWait, { once: true });
      timer = setTimeout(() => {
        signal.removeEventListener("abort", cancelWait);
        resolve();
      }, Math.min(wait, SPEECH_WAIT_STEP_MS));
    });
    signal.throwIfAborted();
    // 分の上限を待つ間も、処理中の拡張機能のサービスワーカーを維持する。
    if (wait > SPEECH_WAIT_STEP_MS) await (globalThis.browser || globalThis.chrome).runtime.getPlatformInfo();
  }
}

async function requestSpeechAudio(fetchAudio, signal) {
  let retried = false;
  while (true) {
    await waitForSpeechSlot(signal);
    signal.throwIfAborted();
    const response = await fetchAudio();
    if (response.status !== 429) return response;

    const seconds = Number(response.headers.get("Retry-After"));
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return response;
    speechRetryAt = Math.max(speechRetryAt, Date.now() + seconds * 1000);
    if (retried) return response;
    if (response.body) await response.body.cancel();
    retried = true;
  }
}

async function prepareSpeechClips(chunks, loadAudio, signal) {
  const clips = new Array(chunks.length);
  let nextIndex = 0;
  let failed = false;

  async function prepareNext() {
    while (!failed && nextIndex < chunks.length) {
      signal.throwIfAborted();
      const index = nextIndex++;
      const { input, caption } = chunks[index];
      try {
        clips[index] = { audio: await loadAudio(input), caption };
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  // 応答順にかかわらず、字幕の順序で再生に渡す。
  await Promise.all([prepareNext(), prepareNext()]);
  return clips;
}

function captionLength(text) {
  return Array.from(text.trim()).length;
}

function captionBreak(text) {
  const characters = Array.from(text);
  // 末尾にごく短い字幕が残るときは、その手前から次の字幕に回す。
  const limit = characters.slice(0, Math.min(MAX_CAPTION_LENGTH, characters.length - MIN_CAPTION_LENGTH)).join("");
  const clause = [...limit.matchAll(/[、，；;][」』）〕〉》]*/gu)].at(-1);
  if (clause && captionLength(limit.slice(0, clause.index + clause[0].length)) >= MIN_CAPTION_LENGTH) {
    return clause.index + clause[0].length;
  }

  let wordBoundary = 0;
  for (const { index, isWordLike } of captionWords.segment(text)) {
    if (index > limit.length) break;
    if (isWordLike) wordBoundary = index;
  }
  return captionLength(text.slice(0, wordBoundary)) >= MIN_CAPTION_LENGTH ? wordBoundary : limit.length;
}

function splitSpeechCaptions(text) {
  const pieces = [];
  const normalized = text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  for (const { segment } of captionSentences.segment(normalized)) {
    let remainder = segment;
    while (captionLength(remainder) > MAX_CAPTION_LENGTH) {
      const end = captionBreak(remainder);
      pieces.push(remainder.slice(0, end));
      remainder = remainder.slice(end);
    }
    if (remainder.trim()) pieces.push(remainder);
  }

  const merged = [];
  for (const piece of pieces) {
    const previous = merged.at(-1);
    if (previous && (captionLength(previous) < MIN_CAPTION_LENGTH || captionLength(piece) < MIN_CAPTION_LENGTH)
        && captionLength(previous + piece) <= MAX_CAPTION_LENGTH) {
      merged[merged.length - 1] += piece;
    } else {
      merged.push(piece);
    }
  }

  const chunks = [];
  for (const part of merged) {
    const caption = part.trim();
    const supported = caption
      .replace(/[^\p{Unified_Ideograph}ぁ-ゖゝ-ゟァ-ヺー-ヿｦ-ﾟ々〇〆a-zA-Z0-9Ａ-Ｚａ-ｚ０-９ \t\n!$%&',.\/:?！＄％＆＇，－．／：？～、。〜「」『』〖〗〈〉《》〔〕（）｢｣()\-]/gu, " ")
      .trim();
    if (!/[\p{L}\p{N}]/u.test(supported)) continue;
    const input = captionLength(supported) === 1 ? supported + "。" : supported;
    chunks.push({ caption, input });
  }
  if (!chunks.length) throw new Error("読み上げられる文字がありません。");
  return chunks;
}
