const captureStates = new Map();

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "audio/webm";
}

function computeRms(analyser) {
  const buffer = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = (buffer[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / buffer.length);
}

async function finalizeSegment(tabId) {
  const state = captureStates.get(tabId);
  if (!state || !state.buffers.length) {
    return;
  }

  const timesliceMs = state.vad.timesliceMs || 1000;
  const approxDurationMs = state.buffers.length * timesliceMs;
  const maxRms = state.maxRms;
  const buffers = state.buffers.slice();
  state.buffers = [];
  state.preRoll = [];
  state.maxRms = 0;

  if (approxDurationMs < (state.vad.minSpeechMs || 900)) {
    return;
  }
  if (maxRms < (state.vad.threshold || 0.018)) {
    return;
  }

  const blob = new Blob(buffers, { type: state.mimeType });
  const bytes = await blob.arrayBuffer();
  await chrome.runtime.sendMessage({
    type: "offscreen-audio-segment",
    tabId,
    bytes,
    mimeType: blob.type || state.mimeType,
    approxDurationMs
  });
}

function stopCapture(tabId, fromRecorder = false) {
  const state = captureStates.get(tabId);
  if (!state) {
    return;
  }

  if (state.vadTimer) {
    clearInterval(state.vadTimer);
  }

  finalizeSegment(tabId).catch(() => {});

  if (state.recorder && state.recorder.state !== "inactive" && !fromRecorder) {
    try {
      state.recorder.stop();
    } catch (error) {
      console.warn(error);
    }
  }

  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) {
      track.stop();
    }
  }

  if (state.audioContext) {
    state.audioContext.close().catch(() => {});
  }

  captureStates.delete(tabId);
}

function handleData(tabId, blob) {
  const state = captureStates.get(tabId);
  if (!state || !blob || blob.size === 0) {
    return;
  }

  const maxPreRollBlobs = state.vad.preRollBlobs || 2;

  if (state.isSpeaking) {
    state.buffers.push(blob);
    const timesliceMs = state.vad.timesliceMs || 1000;
    const totalDurationMs = state.buffers.length * timesliceMs;
    if (totalDurationMs >= (state.vad.maxSegmentMs || 12000)) {
      finalizeSegment(tabId).catch(() => {});
      state.isSpeaking = false;
      state.lastSpeechAt = 0;
    }
  } else {
    state.preRoll.push(blob);
    while (state.preRoll.length > maxPreRollBlobs) {
      state.preRoll.shift();
    }
  }
}

function watchVad(tabId) {
  const state = captureStates.get(tabId);
  if (!state) {
    return;
  }

  const rms = computeRms(state.analyser);
  const now = Date.now();
  const threshold = state.vad.threshold || 0.018;

  if (rms >= threshold) {
    state.maxRms = Math.max(state.maxRms, rms);
    state.lastSpeechAt = now;
    if (!state.isSpeaking) {
      state.isSpeaking = true;
      state.speechStartedAt = now;
      state.buffers = state.preRoll.slice();
      state.preRoll = [];
    }
    return;
  }

  if (state.isSpeaking && now - state.lastSpeechAt > (state.vad.silenceMs || 900)) {
    finalizeSegment(tabId).catch(() => {});
    state.isSpeaking = false;
    state.speechStartedAt = 0;
    state.lastSpeechAt = 0;
  }
}

async function startCapture(tabId, streamId, vad) {
  if (captureStates.has(tabId)) {
    return;
  }

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioContext = new AudioContext();
  await audioContext.resume().catch(() => {});

  const source = audioContext.createMediaStreamSource(mediaStream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  source.connect(audioContext.destination);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(mediaStream, { mimeType });
  const state = {
    tabId,
    mimeType,
    mediaStream,
    recorder,
    audioContext,
    analyser,
    buffers: [],
    preRoll: [],
    isSpeaking: false,
    speechStartedAt: 0,
    lastSpeechAt: 0,
    maxRms: 0,
    vad: {
      threshold: 0.018,
      silenceMs: 900,
      minSpeechMs: 900,
      maxSegmentMs: 12000,
      timesliceMs: 1000,
      preRollBlobs: 2,
      ...(vad || {})
    },
    vadTimer: null
  };

  recorder.addEventListener("dataavailable", (event) => {
    handleData(tabId, event.data);
  });

  recorder.addEventListener("stop", () => {
    stopCapture(tabId, true);
  });

  state.vadTimer = setInterval(() => {
    watchVad(tabId);
  }, 150);

  captureStates.set(tabId, state);
  recorder.start(state.vad.timesliceMs || 1000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return;
  }

  (async () => {
    switch (message.type) {
      case "offscreen-start-capture":
        await startCapture(message.tabId, message.streamId, message.vad || {});
        sendResponse({ ok: true });
        return;
      case "offscreen-stop-capture":
        stopCapture(message.tabId);
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false, error: "Unknown offscreen message type." });
    }
  })().catch((error) => {
    console.error(error);
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
