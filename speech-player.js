const player = new Audio();
let playback;
let audioContext;
let analyser;
let samples;
let meterTimer;

function notifyPlayback(session, status) {
  void chrome.runtime.sendMessage({
    action: "selection_speech_playback", requestId: session.requestId, ...status
  }).catch(() => {});
}

function finishPlayback(session) {
  if (session !== playback) return;
  playback = undefined;
  clearInterval(meterTimer);
  meterTimer = undefined;
  player.pause();
  player.removeAttribute("src");
  player.load();
  notifyPlayback(session, { state: "hidden" });
}

function sendAudioLevel(session) {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  notifyPlayback(session, { level: Math.min(1, Math.sqrt(sum / samples.length) * 4) });
}

async function playNextSpeechChunk(session) {
  if (session !== playback) return;
  const encodedAudio = session.queue.shift();
  if (!encodedAudio) {
    if (session.final) finishPlayback(session);
    return;
  }

  session.playing = true;
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Float32Array(analyser.fftSize);
      audioContext.createMediaElementSource(player).connect(analyser);
      analyser.connect(audioContext.destination);
    }
    player.src = `data:audio/mpeg;base64,${encodedAudio}`;
    await Promise.all([audioContext.resume(), player.play()]);
    if (session !== playback) return;
    notifyPlayback(session, { state: "playing" });
    meterTimer = setInterval(() => sendAudioLevel(session), 66);
  } catch (error) {
    finishPlayback(session);
    throw error;
  }
}

player.addEventListener("ended", () => {
  const session = playback;
  if (!session) return;
  clearInterval(meterTimer);
  meterTimer = undefined;
  session.playing = false;
  notifyPlayback(session, { level: 0 });
  playNextSpeechChunk(session).catch(error => console.warn("読み上げを再生できませんでした:", error.message));
});

player.addEventListener("error", () => {
  if (playback && meterTimer !== undefined) {
    console.warn("読み上げを再生できませんでした:", player.error?.message);
    finishPlayback(playback);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "cancel_selection_speech") {
    if (playback && playback.requestId === message.requestId) finishPlayback(playback);
    sendResponse({ success: true });
    return;
  }

  if (message.action !== "play_selection_speech") return;
  if (playback?.requestId !== message.requestId) {
    if (playback) finishPlayback(playback);
    playback = { requestId: message.requestId, queue: [], final: false, playing: false };
  }
  const session = playback;
  session.queue.push(message.audio);
  session.final = message.final;
  if (session.playing) {
    sendResponse({ success: true });
    return;
  }
  playNextSpeechChunk(session)
    .then(() => sendResponse({ success: true }))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
