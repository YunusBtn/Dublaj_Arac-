if (!globalThis.__udemyTrDubContentLoaded) {
  globalThis.__udemyTrDubContentLoaded = true;

  const overlayState = {
    settings: null,
    sessionActive: false,
    mode: "idle",
    overlay: null,
    statusEl: null,
    targetEl: null,
    sourceEl: null,
    noteEl: null,
    observedTrack: null,
    observedTrackHandler: null,
    originalTrackMode: null,
    trackPollTimer: null,
    captionPollTimer: null,
    slots: { current: null, next: null, prefetch: null },
    currentRequestId: null,
    sttSeqAccepted: 0,
    ttsBusy: false,
    currentUtterance: null,
    currentAudio: null,
    currentPlayback: null,
    syncMonitorTimer: null,
    savedVolume: null,
    savedMuted: null,
    lastCueKey: "",
    lastCaptionText: "",
    observedVideo: null,
    lastCaptionSeenAt: 0
  };

  const CAPTION_SELECTORS = [
    "[data-purpose*='caption' i]",
    "[data-purpose*='subtitle' i]",
    "[class*='caption' i]",
    "[class*='subtitle' i]",
    "[aria-live='assertive']",
    "[aria-live='polite']"
  ];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeText(text) {
    const root = document.createElement("div");
    root.innerHTML = String(text || "");
    return (root.textContent || root.innerText || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isProbablyNoiseCaptionText(text) {
    const value = normalizeText(text).toLowerCase();
    if (!value) return true;
    if (/^\d+$/.test(value)) return true;
    if (/^\d+\s*(dak|dk|min|saat|sa|sn|sec|second|seconds|minute|minutes|hour|hours)$/.test(value)) return true;
    if (/^(ai assistant|kurs icerigi|genel bakis|soru-cevap|notlar|duyurular|yorumlar|ogrenim araclari)$/.test(value)) return true;
    if (/^\d+\s*(daha|more)$/.test(value)) return true;
    if (value.length <= 2) return true;
    return false;
  }

  function getDeepRoots(root = document) {
    const roots = [];
    const queue = [root];
    const seen = new Set();

    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) {
        continue;
      }
      seen.add(current);
      roots.push(current);

      let elements = [];
      try {
        elements = Array.from(current.querySelectorAll ? current.querySelectorAll("*") : []);
      } catch (error) {
        elements = [];
      }

      for (const element of elements) {
        if (element?.shadowRoot && !seen.has(element.shadowRoot)) {
          queue.push(element.shadowRoot);
        }
      }
    }

    return roots;
  }

  function queryAllDeep(selector) {
    const results = [];
    const seen = new Set();
    for (const root of getDeepRoots(document)) {
      let matches = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
      } catch (error) {
        matches = [];
      }
      for (const match of matches) {
        if (!seen.has(match)) {
          seen.add(match);
          results.push(match);
        }
      }
    }
    return results;
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (!style) {
      return true;
    }
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.01;
  }

  function scoreVideo(video) {
    if (!video) {
      return -Infinity;
    }
    const rect = video.getBoundingClientRect();
    if (!rect || rect.width < 80 || rect.height < 45) {
      return -Infinity;
    }
    const style = window.getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden") {
      return -Infinity;
    }

    const areaScore = Math.min(120, (rect.width * rect.height) / 18000);
    const readinessScore = Number(video.readyState || 0) * 12;
    const sourceScore = (video.currentSrc || video.src) ? 25 : 0;
    const playingScore = !video.paused ? 18 : 0;
    return areaScore + readinessScore + sourceScore + playingScore;
  }

  function findVideo() {
    const candidates = queryAllDeep("video");
    if (!candidates.length) {
      return null;
    }
    const ranked = candidates
      .map((video) => ({ video, score: scoreVideo(video) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.video || null;
  }

  function getTrackDetails(video) {
    if (!video || !video.textTracks) {
      return [];
    }
    return Array.from(video.textTracks).map((track, index) => ({
      index,
      kind: track.kind || "",
      label: track.label || "",
      language: track.language || "",
      mode: track.mode || "disabled"
    }));
  }

  function pickPreferredTrack(video) {
    const tracks = Array.from(video?.textTracks || []);
    if (!tracks.length) {
      return null;
    }
    const current = tracks.find((track) => track.mode === "showing" || track.mode === "hidden");
    if (current) {
      return current;
    }
    const english = tracks.find((track) => {
      const label = String(track.label || "").toLowerCase();
      const lang = String(track.language || "").toLowerCase();
      return label.includes("english") || lang.startsWith("en");
    });
    return english || tracks[0];
  }

  function getElementText(element) {
    return normalizeText(element?.innerText || element?.textContent || "");
  }

  function getVideoRect(video) {
    const rect = video?.getBoundingClientRect?.();
    if (!rect) {
      return null;
    }
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  function scoreCaptionElement(element, videoRect) {
    if (!isVisibleElement(element)) {
      return -Infinity;
    }

    const text = getElementText(element);
    if (!text || text.length < 2 || text.length > 240 || isProbablyNoiseCaptionText(text)) {
      return -Infinity;
    }

    const rect = element.getBoundingClientRect();
    const descriptor = `${element.className || ""} ${element.id || ""} ${element.getAttribute?.("data-purpose") || ""}`.toLowerCase();
    const style = window.getComputedStyle(element);
    const lineCount = String(element.innerText || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean).length;

    let score = 0;
    if (descriptor.includes("caption")) score += 55;
    if (descriptor.includes("subtitle")) score += 55;
    if (descriptor.includes("transcript")) score -= 25;
    if (element.getAttribute?.("aria-live")) score += 18;
    if (style.position === "absolute" || style.position === "fixed") score += 12;
    if (lineCount > 0 && lineCount <= 3) score += 10;
    if (text.length <= 120) score += 8;

    if (videoRect) {
      const overlapX = Math.max(0, Math.min(rect.right, videoRect.right) - Math.max(rect.left, videoRect.left));
      const centerX = rect.left + rect.width / 2;
      const videoCenterX = videoRect.left + videoRect.width / 2;
      const centerDelta = Math.abs(centerX - videoCenterX);
      const inLowerBand = rect.top >= videoRect.top + videoRect.height * 0.35 && rect.bottom <= videoRect.bottom + 60;
      const mostlyInsideVideo = rect.left >= videoRect.left - 40 && rect.right <= videoRect.right + 40;
      if (overlapX > rect.width * 0.45) score += 20;
      if (inLowerBand) score += 24;
      if (mostlyInsideVideo) score += 14;
      if (!inLowerBand && !mostlyInsideVideo) score -= 40;
      score += Math.max(0, 16 - centerDelta / 35);
    } else {
      if (rect.top > window.innerHeight * 0.25) score += 6;
    }

    return score;
  }

  function findCaptionElement(video = null) {
    const videoRect = getVideoRect(video);
    const candidates = [];
    for (const selector of CAPTION_SELECTORS) {
      candidates.push(...queryAllDeep(selector));
    }

    const ranked = candidates
      .map((element) => ({ element, score: scoreCaptionElement(element, videoRect) }))
      .filter((item) => Number.isFinite(item.score) && item.score > 38)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.element || null;
  }

  function estimateDurationSeconds(text) {
    const words = Math.max(1, normalizeText(text).split(/\s+/).length);
    return clamp(words / 2.6, 2, 7);
  }

  function ensureOverlay() {
    if (overlayState.overlay) {
      moveOverlayToActiveContainer();
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = "udemy-tr-dub-overlay";
    overlay.innerHTML = `
      <div class="utr-card">
        <div class="utr-status">Hazir</div>
        <div class="utr-target"></div>
        <div class="utr-source"></div>
        <div class="utr-note utr-hidden">AI voice active</div>
      </div>
    `;

    overlayState.overlay = overlay;
    overlayState.statusEl = overlay.querySelector(".utr-status");
    overlayState.targetEl = overlay.querySelector(".utr-target");
    overlayState.sourceEl = overlay.querySelector(".utr-source");
    overlayState.noteEl = overlay.querySelector(".utr-note");

    moveOverlayToActiveContainer();
    document.addEventListener("fullscreenchange", moveOverlayToActiveContainer);
  }

  function moveOverlayToActiveContainer() {
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (!overlayState.overlay || !parent) {
      return;
    }
    if (overlayState.overlay.parentElement !== parent) {
      parent.appendChild(overlayState.overlay);
    }
  }

  function setOverlayVisibility(visible) {
    ensureOverlay();
    overlayState.overlay.classList.toggle("visible", Boolean(visible));
  }

  function renderStatus(text) {
    ensureOverlay();
    overlayState.statusEl.textContent = text;
  }

  function renderSegment(sourceText, translatedText, origin, settings) {
    ensureOverlay();
    overlayState.overlay.classList.toggle("compact", Boolean(settings?.overlayCompact));
    overlayState.targetEl.textContent = translatedText || "";
    overlayState.sourceEl.textContent = settings?.showSourceText ? (sourceText || "") : "";
    overlayState.sourceEl.style.display = settings?.showSourceText ? "block" : "none";
    overlayState.noteEl.classList.toggle("utr-hidden", !settings?.enableDubbing);

    if (origin === "stt") {
      renderStatus("Canli STT + TR");
    } else if (origin === "dom") {
      renderStatus("Gorunen altyazi + TR");
    } else {
      renderStatus("Text track + TR");
    }

    setOverlayVisibility(Boolean(translatedText));
  }

  function notify(text, level) {
    const prefix = level === "warn" ? "Uyari" : "Bilgi";
    renderStatus(`${prefix}: ${text}`);
    setOverlayVisibility(true);
  }

  function stopTrackMode() {
    if (overlayState.observedTrack && overlayState.observedTrackHandler) {
      try {
        overlayState.observedTrack.removeEventListener("cuechange", overlayState.observedTrackHandler);
      } catch (error) {
        console.debug(error);
      }
    }
    if (overlayState.trackPollTimer) {
      window.clearInterval(overlayState.trackPollTimer);
    }
    if (overlayState.observedTrack && overlayState.originalTrackMode && overlayState.observedTrack.mode === "hidden") {
      try {
        overlayState.observedTrack.mode = overlayState.originalTrackMode;
      } catch (error) {
        console.debug(error);
      }
    }
    overlayState.observedTrack = null;
    overlayState.observedTrackHandler = null;
    overlayState.originalTrackMode = null;
    overlayState.trackPollTimer = null;
    overlayState.lastCueKey = "";
  }

  function stopCaptionMode() {
    if (overlayState.captionPollTimer) {
      window.clearInterval(overlayState.captionPollTimer);
    }
    overlayState.captionPollTimer = null;
    overlayState.lastCaptionText = "";
    overlayState.lastCaptionSeenAt = 0;
  }

  function createPendingSlot(requestId, payload) {
    return {
      requestId,
      revealed: false,
      status: "pending",
      kind: null,
      sourceText: payload.text || "",
      translatedText: "",
      speechText: "",
      origin: payload.origin || "subtitle",
      startTime: Number.isFinite(Number(payload.startTime)) ? Number(payload.startTime) : null,
      endTime: Number.isFinite(Number(payload.endTime)) ? Number(payload.endTime) : null,
      durationMs: 0,
      settings: overlayState.settings,
      audioBytes: null,
      audioEl: null,
      objectUrl: null,
      audioDuration: null
    };
  }

  function findSlotByRequestId(requestId) {
    if (overlayState.slots.current?.requestId === requestId) {
      return overlayState.slots.current;
    }
    if (overlayState.slots.next?.requestId === requestId) {
      return overlayState.slots.next;
    }
    if (overlayState.slots.prefetch?.requestId === requestId) {
      return overlayState.slots.prefetch;
    }
    return null;
  }

  function cancelSlot(slot, { abortTts = false } = {}) {
    if (!slot) {
      return;
    }
    if (abortTts && slot.status === "fetching" && slot.kind === "openai") {
      chrome.runtime.sendMessage({ type: "tts-cancel", requestId: slot.requestId }).catch(() => {});
    }
    if (slot.audioEl) {
      try {
        slot.audioEl.pause();
      } catch (error) {
        console.debug(error);
      }
      slot.audioEl = null;
    }
    if (slot.objectUrl) {
      URL.revokeObjectURL(slot.objectUrl);
      slot.objectUrl = null;
    }
  }

  function finalizeSlot(slot) {
    if (overlayState.slots.current === slot) {
      overlayState.slots.current = null;
      overlayState.currentRequestId = null;
    }
    if (overlayState.slots.next === slot) {
      overlayState.slots.next = null;
    }
    if (slot.objectUrl) {
      URL.revokeObjectURL(slot.objectUrl);
      slot.objectUrl = null;
    }
  }

  function promoteNextIfNeeded() {
    if (overlayState.slots.current || !overlayState.slots.next) {
      return;
    }
    const slot = overlayState.slots.next;
    overlayState.slots.next = null;
    overlayState.slots.current = slot;
    overlayState.currentRequestId = slot.requestId;
    renderSegment(slot.sourceText, slot.translatedText, slot.origin, slot.settings);

    if (overlayState.slots.prefetch) {
      overlayState.slots.next = overlayState.slots.prefetch;
      overlayState.slots.prefetch = null;
    }
  }

  function revealSlot(slot) {
    if (!slot || slot.revealed) {
      return;
    }
    slot.revealed = true;
    renderSegment(slot.sourceText, slot.translatedText, slot.origin, slot.settings);
    void runScheduler();
  }

  function pruneSlots() {
    const current = overlayState.slots.current;
    if (current && current.status !== "playing") {
      const grace = current.status === "fetching" ? 80 : 100;
      if (isItemExpired(current, grace)) {
        cancelSlot(current);
        overlayState.slots.current = null;
        overlayState.currentRequestId = null;
      }
    }

    const next = overlayState.slots.next;
    if (next && isItemExpired(next, 100)) {
      cancelSlot(next);
      overlayState.slots.next = null;
    }

    const prefetch = overlayState.slots.prefetch;
    if (prefetch && isItemExpired(prefetch, 100)) {
      cancelSlot(prefetch);
      overlayState.slots.prefetch = null;
    }

    promoteNextIfNeeded();
  }

  function attachAudioToSlot(slot, audioBytes) {
    slot.audioBytes = audioBytes;
    const blob = new Blob([audioBytes], { type: "audio/mpeg" });
    slot.objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(slot.objectUrl);
    audio.preload = "auto";
    slot.audioEl = audio;
    audio.addEventListener("loadedmetadata", () => {
      slot.audioDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
    }, { once: true });
    slot.status = "ready";
  }

  function submitSegment({ requestId, text, startTime, endTime, origin, playbackRate }) {
    const current = overlayState.slots.current;
    const next = overlayState.slots.next;

    if (current && next) {
      const nextIsLagging = Number.isFinite(next.startTime) && Number.isFinite(current.endTime)
        && next.startTime < current.endTime - 1;
      if (!nextIsLagging) {
        return;
      }
      cancelSlot(next);
      overlayState.slots.next = null;
    }

    const slot = createPendingSlot(requestId, { text, startTime, endTime, origin });

    if (!overlayState.slots.current) {
      overlayState.slots.current = slot;
      overlayState.currentRequestId = requestId;
    } else {
      overlayState.slots.next = slot;
    }

    chrome.runtime.sendMessage({
      type: "content-subtitle-segment",
      requestId,
      isLookahead: false,
      text,
      startTime,
      endTime,
      origin,
      playbackRate
    }).catch(() => {});

    void runScheduler();
  }

  function clearAllSlots() {
    if (overlayState.slots.current) {
      cancelSlot(overlayState.slots.current, { abortTts: true });
      overlayState.slots.current = null;
    }
    if (overlayState.slots.next) {
      cancelSlot(overlayState.slots.next, { abortTts: true });
      overlayState.slots.next = null;
    }
    if (overlayState.slots.prefetch) {
      cancelSlot(overlayState.slots.prefetch, { abortTts: true });
      overlayState.slots.prefetch = null;
    }
    overlayState.currentRequestId = null;
    interruptCurrentPlayback();
    restoreDucking();
  }

  function runScheduler() {
    if (!overlayState.sessionActive) {
      return;
    }

    const video = getActiveVideo();
    if (video?.ended) {
      clearAllSlots();
      return;
    }

    pruneSlots();

    if (overlayState.currentPlayback) {
      if (shouldInterruptCurrentPlayback(overlayState.currentPlayback)) {
        interruptCurrentPlayback();
      }
      return;
    }

    if (overlayState.ttsBusy) {
      return;
    }

    const current = overlayState.slots.current;
    if (!current) {
      restoreDucking();
      return;
    }

    if (current.status === "ready") {
      void playSlot(current);
      return;
    }

    if (current.status === "done") {
      finalizeSlot(current);
      promoteNextIfNeeded();
      void runScheduler();
      return;
    }
  }

  function playSlot(slot) {
    if (slot.kind === "off" || shouldSkipBeforePlay(slot)) {
      finalizeSlot(slot);
      promoteNextIfNeeded();
      void runScheduler();
      return Promise.resolve();
    }

    overlayState.ttsBusy = true;
    applyDucking();
    slot.status = "playing";

    const playPromise = slot.kind === "openai" ? playOpenAiSlot(slot) : speakBrowserSlot(slot);

    return playPromise
      .catch((error) => console.warn(error))
      .finally(() => {
        overlayState.ttsBusy = false;
        finalizeSlot(slot);
        promoteNextIfNeeded();
        void runScheduler();
      });
  }

  function speakBrowserSlot(slot) {
    return new Promise((resolve) => {
      const text = normalizeText(slot.speechText || slot.translatedText || "");
      if (!text) {
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      const voice = chooseBrowserVoice(slot.settings || overlayState.settings);
      utterance.lang = voice?.lang || "tr-TR";
      utterance.rate = estimateBrowserRate(slot);
      if (voice) {
        utterance.voice = voice;
      }

      overlayState.currentUtterance = utterance;
      overlayState.currentPlayback = {
        kind: "browser",
        item: slot,
        resolve,
        finished: false,
        objectUrl: ""
      };

      utterance.onend = () => {
        finishCurrentPlayback();
      };
      utterance.onerror = () => {
        finishCurrentPlayback();
      };

      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  function playOpenAiSlot(slot) {
    return new Promise((resolve) => {
      if (!slot.audioEl) {
        resolve();
        return;
      }

      const audio = slot.audioEl;
      overlayState.currentAudio = audio;

      const applyRate = () => {
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : slot.audioDuration;
        audio.playbackRate = computeIdealRate(slot, duration);
      };

      applyRate();
      if (!(Number.isFinite(audio.duration) && audio.duration > 0)) {
        audio.addEventListener("loadedmetadata", applyRate, { once: true });
      }

      overlayState.currentPlayback = {
        kind: "openai",
        item: slot,
        resolve,
        finished: false,
        objectUrl: slot.objectUrl || ""
      };

      audio.onended = () => {
        finishCurrentPlayback();
      };
      audio.onerror = () => {
        finishCurrentPlayback();
      };

      audio.play().catch(() => {
        finishCurrentPlayback();
      });
    });
  }

  function findNextCue(track, afterCue) {
    if (!afterCue) {
      return null;
    }
    const cues = Array.from(track?.cues || []);
    if (!cues.length) {
      return null;
    }
    const afterEnd = Number(afterCue.endTime);
    let best = null;
    for (const cue of cues) {
      const start = Number(cue.startTime);
      if (!Number.isFinite(start) || start < afterEnd) {
        continue;
      }
      if (!best || start < Number(best.startTime)) {
        best = cue;
      }
    }
    return best;
  }

  function emitTrackCue(track, video) {
    const activeCues = Array.from(track.activeCues || []);
    if (!activeCues.length) {
      return;
    }
    const sourceText = normalizeText(activeCues.map((cue) => cue.text || "").join(" "));
    if (!sourceText) {
      return;
    }
    const cue = activeCues[0];
    const startTime = Number(cue?.startTime ?? video.currentTime ?? 0);
    const endTime = Number.isFinite(Number(cue?.endTime)) ? Number(cue.endTime) : startTime + 3;
    const playbackRate = Number(video?.playbackRate || 1);
    const cueKey = `${Math.round(startTime * 10)}|${sourceText}`;

    if (cueKey !== overlayState.lastCueKey) {
      overlayState.lastCueKey = cueKey;

      if (overlayState.slots.next?.requestId === startTime) {
        revealSlot(overlayState.slots.next);
      } else {
        submitSegment({ requestId: startTime, text: sourceText, startTime, endTime, origin: "subtitle", playbackRate });
      }
    }

    const nextCue = findNextCue(track, cue);
    if (!nextCue) {
      return;
    }

    const nextStart = Number(nextCue.startTime);
    const nextEnd = Number.isFinite(Number(nextCue.endTime)) ? Number(nextCue.endTime) : nextStart + 3;
    const nextText = normalizeText(nextCue.text || "");
    const longEnough = (nextEnd - nextStart) >= 1.5;

    if (!nextText || !longEnough) {
      return;
    }

    if (overlayState.slots.next?.requestId === nextStart || overlayState.slots.prefetch?.requestId === nextStart) {
      return;
    }

    if (overlayState.slots.next && overlayState.slots.prefetch) {
      cancelSlot(overlayState.slots.prefetch);
      overlayState.slots.prefetch = null;
    }

    chrome.runtime.sendMessage({
      type: "content-subtitle-segment",
      requestId: nextStart,
      isLookahead: true,
      text: nextText,
      startTime: nextStart,
      endTime: nextEnd,
      origin: "subtitle",
      playbackRate
    }).catch(() => {});
  }

  function beginTrackMode() {
    stopTrackMode();
    const video = findVideo();
    if (!video) {
      return false;
    }
    const track = pickPreferredTrack(video);
    if (!track) {
      return false;
    }

    overlayState.observedVideo = video;
    overlayState.observedTrack = track;
    overlayState.originalTrackMode = track.mode;

    try {
      if (track.mode === "disabled") {
        track.mode = "hidden";
      }
    } catch (error) {
      console.debug(error);
    }

    const handler = () => emitTrackCue(track, video);
    overlayState.observedTrackHandler = handler;

    try {
      track.addEventListener("cuechange", handler);
    } catch (error) {
      console.debug(error);
    }

    overlayState.trackPollTimer = window.setInterval(handler, 400);
    handler();
    return true;
  }

  function beginCaptionMode() {
    stopCaptionMode();

    const poll = () => {
      const video = findVideo();
      if (video) {
        overlayState.observedVideo = video;
      }
      const settings = overlayState.settings || {};
      const captionEl = findCaptionElement(video || overlayState.observedVideo);
      if (!captionEl) {
        if (settings.strictCaptionMode !== false && overlayState.lastCaptionSeenAt && Date.now() - overlayState.lastCaptionSeenAt > 900) {
          overlayState.lastCaptionText = "";
        }
        return;
      }
      const sourceText = getElementText(captionEl);
      if (!sourceText || isProbablyNoiseCaptionText(sourceText)) {
        if (settings.strictCaptionMode !== false && overlayState.lastCaptionSeenAt && Date.now() - overlayState.lastCaptionSeenAt > 900) {
          overlayState.lastCaptionText = "";
        }
        return;
      }
      overlayState.lastCaptionSeenAt = Date.now();
      if (sourceText === overlayState.lastCaptionText) {
        return;
      }
      overlayState.lastCaptionText = sourceText;

      const timeBase = video?.currentTime || overlayState.observedVideo?.currentTime || (Date.now() / 1000);
      const duration = estimateDurationSeconds(sourceText);

      submitSegment({
        requestId: Date.now(),
        text: sourceText,
        startTime: timeBase,
        endTime: timeBase + duration,
        origin: "dom",
        playbackRate: Number((video || overlayState.observedVideo)?.playbackRate || 1)
      });
    };

    overlayState.captionPollTimer = window.setInterval(poll, 350);
    poll();
    return true;
  }

  function getContentState() {
    return {
      sessionActive: overlayState.sessionActive,
      mode: overlayState.mode,
      queueLength: (overlayState.slots.current ? 1 : 0) + (overlayState.slots.next ? 1 : 0) + (overlayState.slots.prefetch ? 1 : 0),
      overlayVisible: overlayState.overlay?.classList.contains("visible") || false
    };
  }

  function probeVideo() {
    const video = findVideo();
    const tracks = getTrackDetails(video);
    const captionEl = findCaptionElement(video);
    return {
      hasVideo: Boolean(video),
      hasUsableTextTrack: tracks.length > 0,
      hasDomCaptions: Boolean(captionEl),
      tracks,
      currentTime: video?.currentTime || 0,
      captionSample: captionEl && !isProbablyNoiseCaptionText(getElementText(captionEl)) ? getElementText(captionEl).slice(0, 140) : ""
    };
  }

  function saveCurrentVolume(video) {
    if (!video || overlayState.savedVolume !== null) {
      return;
    }
    overlayState.savedVolume = video.volume;
    overlayState.savedMuted = video.muted;
  }

  function applyDucking() {
    const video = findVideo();
    if (!video || !overlayState.settings?.enableDubbing) {
      return;
    }
    saveCurrentVolume(video);
    video.muted = false;
    const duckingVolume = clamp(Number(overlayState.settings?.duckingVolume || 0.18), 0, 1);
    video.volume = Math.min(video.volume, duckingVolume);
  }

  function restoreDucking() {
    const video = findVideo();
    if (!video) {
      overlayState.savedVolume = null;
      overlayState.savedMuted = null;
      return;
    }
    if (overlayState.savedVolume !== null) {
      video.volume = overlayState.savedVolume;
    }
    if (overlayState.savedMuted !== null) {
      video.muted = overlayState.savedMuted;
    }
    overlayState.savedVolume = null;
    overlayState.savedMuted = null;
  }

  function listBrowserVoices() {
    return Array.from(window.speechSynthesis?.getVoices?.() || []);
  }

  function chooseBrowserVoice(settings) {
    const voices = listBrowserVoices();
    const preferredUri = String(settings?.browserVoiceURI || "");
    const preferredName = String(settings?.browserVoiceName || "");

    if (preferredUri) {
      const voiceByUri = voices.find((voice) => String(voice.voiceURI || "") === preferredUri);
      if (voiceByUri) {
        return voiceByUri;
      }
    }

    if (preferredName) {
      const voiceByName = voices.find((voice) => String(voice.name || "") === preferredName);
      if (voiceByName) {
        return voiceByName;
      }
    }

    return voices.find((voice) => String(voice.lang || "").toLowerCase().startsWith("tr")) || voices[0] || null;
  }

  function getActiveVideo() {
    const video = findVideo() || overlayState.observedVideo || null;
    if (video) {
      overlayState.observedVideo = video;
    }
    return video;
  }

  function getPlaybackRate() {
    const rate = Number(getActiveVideo()?.playbackRate || 1);
    return clamp(Number.isFinite(rate) ? rate : 1, 0.25, 4);
  }

  function isSyncDubbingEnabled(settings = overlayState.settings) {
    return settings?.syncDubbing !== false;
  }

  function computeIdealRate(slot, audioDurationSeconds) {
    const maxRate = clamp(Number(slot?.settings?.ttsMaxRate || overlayState.settings?.ttsMaxRate || 2.25), 1, 3);
    const baseRate = clamp(getPlaybackRate(), 1, maxRate);
    const cueWindowSeconds = Number(slot?.durationMs || 0) / 1000;

    if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0 || cueWindowSeconds <= 0) {
      return baseRate;
    }

    const idealRate = audioDurationSeconds / cueWindowSeconds;
    return clamp(idealRate, 1, maxRate);
  }

  function estimateSpeechSeconds(text) {
    const words = Math.max(1, normalizeText(text).split(/\s+/).filter(Boolean).length);
    return words / 2.45;
  }

  function getOverdueWallMs(item, graceMs = 0) {
    if (!item || !Number.isFinite(item.endTime)) {
      return 0;
    }
    const video = getActiveVideo();
    if (!video) {
      return 0;
    }
    const rate = getPlaybackRate();
    const graceMediaSeconds = (Math.max(0, graceMs) / 1000) * rate;
    const overdueMediaSeconds = Number(video.currentTime || 0) - Number(item.endTime) - graceMediaSeconds;
    return Math.max(0, (overdueMediaSeconds * 1000) / rate);
  }

  function shouldInterruptCurrentPlayback(playback = overlayState.currentPlayback) {
    if (!playback?.item) {
      return false;
    }

    const settings = playback.item.settings || overlayState.settings;
    if (!isSyncDubbingEnabled(settings)) {
      return false;
    }

    if (!overlayState.slots.next) {
      return false;
    }

    return getOverdueWallMs(playback.item, 0) >= 8000;
  }

  function getRemainingWallMs(item, fallbackMs = 0) {
    if (item && Number.isFinite(item.endTime)) {
      const video = getActiveVideo();
      if (video) {
        const remainingMediaSeconds = Number(item.endTime) - Number(video.currentTime || 0);
        return Math.max(0, (remainingMediaSeconds * 1000) / getPlaybackRate());
      }
    }
    return Math.max(0, Number(fallbackMs || item?.durationMs || 0));
  }

  function isItemExpired(item, graceMs = 120) {
    if (!item || !Number.isFinite(item.endTime)) {
      return false;
    }
    const video = getActiveVideo();
    if (!video) {
      return false;
    }
    const graceMediaSeconds = (graceMs / 1000) * getPlaybackRate();
    return Number(video.currentTime || 0) > Number(item.endTime) + graceMediaSeconds;
  }

  function shouldSkipBeforePlay(item) {
    if (!item) {
      return true;
    }
    if (isItemExpired(item, 120)) {
      return true;
    }
    if (Number.isFinite(item.endTime)) {
      return getRemainingWallMs(item, item.durationMs || 0) < 220;
    }
    return false;
  }

  function finishCurrentPlayback() {
    const playback = overlayState.currentPlayback;
    if (!playback || playback.finished) {
      return;
    }

    playback.finished = true;
    const resolve = playback.resolve;

    overlayState.currentPlayback = null;
    overlayState.currentUtterance = null;

    if (overlayState.currentAudio) {
      try {
        overlayState.currentAudio.pause();
      } catch (error) {
        console.debug(error);
      }
      overlayState.currentAudio = null;
    }

    if (typeof resolve === "function") {
      resolve();
    }
  }

  function interruptCurrentPlayback() {
    const playback = overlayState.currentPlayback;
    if (!playback) {
      return;
    }

    if (playback.kind === "browser") {
      try {
        window.speechSynthesis.cancel();
      } catch (error) {
        console.debug(error);
      }
    }

    if (playback.kind === "openai" && overlayState.currentAudio) {
      try {
        overlayState.currentAudio.pause();
      } catch (error) {
        console.debug(error);
      }
    }

    finishCurrentPlayback();
  }

  function startSyncMonitor() {
    if (overlayState.syncMonitorTimer) {
      return;
    }

    overlayState.syncMonitorTimer = window.setInterval(() => {
      void runScheduler();
    }, 120);
  }

  function stopSyncMonitor() {
    if (overlayState.syncMonitorTimer) {
      window.clearInterval(overlayState.syncMonitorTimer);
      overlayState.syncMonitorTimer = null;
    }
  }

  function estimateBrowserRate(item) {
    const text = normalizeText(item?.speechText || item?.translatedText || "");
    return computeIdealRate(item, text ? estimateSpeechSeconds(text) : 0);
  }

  function startSession(message) {
    overlayState.settings = message.settings || {};
    overlayState.sessionActive = true;
    overlayState.mode = message.mode || "track";
    overlayState.lastCueKey = "";
    overlayState.lastCaptionText = "";
    overlayState.slots = { current: null, next: null };
    overlayState.currentRequestId = null;
    overlayState.sttSeqAccepted = 0;
    ensureOverlay();
    overlayState.overlay.classList.toggle("compact", Boolean(overlayState.settings.overlayCompact));
    setOverlayVisibility(true);
    startSyncMonitor();

    stopTrackMode();
    stopCaptionMode();

    if (overlayState.mode === "track") {
      const ok = beginTrackMode();
      if (ok) {
        renderStatus("Text track izleniyor...");
      } else {
        beginCaptionMode();
        renderStatus("Text track bulunamadi, gorunen altyazi izleniyor...");
      }
      return;
    }

    if (overlayState.mode === "dom") {
      beginCaptionMode();
      renderStatus("Gorunen altyazi izleniyor...");
      return;
    }

    renderStatus("Audio transcription aktif. Kisa gecikme normaldir.");
  }

  function stopSession() {
    overlayState.sessionActive = false;
    overlayState.mode = "idle";
    stopTrackMode();
    stopCaptionMode();
    clearAllSlots();
    stopSyncMonitor();
    renderStatus("Durdu");
    if (overlayState.targetEl) overlayState.targetEl.textContent = "";
    if (overlayState.sourceEl) overlayState.sourceEl.textContent = "";
    setOverlayVisibility(false);
  }

  const videoObserver = new MutationObserver(() => {
    if (!overlayState.sessionActive) {
      return;
    }
    if (overlayState.mode === "track") {
      const currentVideo = findVideo();
      if (currentVideo && currentVideo !== overlayState.observedVideo) {
        beginTrackMode();
      }
    }
  });

  videoObserver.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });

  ensureOverlay();

  try {
    window.speechSynthesis?.getVoices?.();
    window.speechSynthesis?.addEventListener?.("voiceschanged", () => {
      window.speechSynthesis?.getVoices?.();
    });
  } catch (error) {
    console.debug("voice init skipped", error);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case "ping-content":
        sendResponse({ ok: true });
        return true;
      case "probe-video":
        sendResponse(probeVideo());
        return true;
      case "content-state":
        sendResponse(getContentState());
        return true;
      case "session-start":
        startSession(message);
        sendResponse({ ok: true });
        return true;
      case "session-stop":
        stopSession();
        sendResponse({ ok: true });
        return true;
      case "translated-segment": {
        const requestId = message.requestId;
        let slot = findSlotByRequestId(requestId);

        if (!slot && message.origin === "stt") {
          if (requestId <= overlayState.sttSeqAccepted) {
            sendResponse({ ok: true });
            return true;
          }
          overlayState.sttSeqAccepted = requestId;

          if (overlayState.slots.next) {
            cancelSlot(overlayState.slots.next);
            overlayState.slots.next = null;
          }
          if (overlayState.slots.current) {
            cancelSlot(overlayState.slots.current);
          }

          slot = createPendingSlot(requestId, {
            text: message.sourceText,
            startTime: null,
            endTime: null,
            origin: message.origin
          });
          slot.durationMs = Math.max(0, Number(message.approxDurationMs || 0));
          overlayState.slots.current = slot;
          overlayState.currentRequestId = requestId;
        }

        if (!slot) {
          sendResponse({ ok: true });
          return true;
        }

        slot.translatedText = message.translatedText || "";
        slot.speechText = message.speechText || slot.translatedText;
        slot.settings = message.settings || overlayState.settings;
        revealSlot(slot);
        sendResponse({ ok: true });
        return true;
      }
      case "prepare-dub": {
        const requestId = message.requestId;
        let slot = findSlotByRequestId(requestId);

        if (!slot && message.isLookahead) {
          const payload = {
            text: message.sourceText,
            startTime: message.startTime,
            endTime: message.endTime,
            origin: "subtitle"
          };
          if (!overlayState.slots.next) {
            slot = createPendingSlot(requestId, payload);
            overlayState.slots.next = slot;
          } else {
            if (overlayState.slots.prefetch) {
              cancelSlot(overlayState.slots.prefetch);
            }
            slot = createPendingSlot(requestId, payload);
            overlayState.slots.prefetch = slot;
          }
        }

        if (!slot) {
          sendResponse({ ok: true });
          return true;
        }

        if (message.sourceText) {
          slot.sourceText = message.sourceText;
        }
        slot.translatedText = message.translatedText || slot.translatedText;
        slot.speechText = message.speechText || slot.translatedText;
        slot.durationMs = Math.max(0, Number(message.durationMs || 0));
        slot.settings = message.settings || overlayState.settings;

        if (message.kind === "openai") {
          slot.kind = "openai";
          slot.status = "fetching";
        } else {
          slot.kind = message.kind === "off" ? "off" : "browser";
          slot.status = "ready";
        }

        void runScheduler();
        sendResponse({ ok: true });
        return true;
      }
      case "tts-ready": {
        const slot = findSlotByRequestId(message.requestId);
        if (!slot) {
          sendResponse({ ok: true });
          return true;
        }
        attachAudioToSlot(slot, message.audioBytes);
        void runScheduler();
        sendResponse({ ok: true });
        return true;
      }
      case "tts-error": {
        const slot = findSlotByRequestId(message.requestId);
        if (!slot) {
          sendResponse({ ok: true });
          return true;
        }
        slot.kind = "browser";
        slot.status = "ready";
        void runScheduler();
        sendResponse({ ok: true });
        return true;
      }
      case "notify":
        notify(message.text, message.level);
        sendResponse({ ok: true });
        return true;
      default:
        return false;
    }
  });
}
