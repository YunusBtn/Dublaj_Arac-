const DEFAULT_PRONUNCIATION_GLOSSARY = [
  "# Sozlu okuma sozlugu: solda terim, sagda okunus",
  "backend=bekent",
  "frontend=frontent",
  "full stack=ful stek",
  "Spring Boot=spring but",
  "REST API=rest ey pi ay",
  "API=ey pi ay",
  "JWT=cey dabilyu ti",
  "JSON=ceysin",
  "endpoint=end point",
  "controller=kontrolir",
  "annotation=anoteysin",
  "repository=ripozitri",
  "Postman=postmen"
].join("\n");

const DEFAULT_TECHNICAL_GLOSSARY = [
  "# Solda teknik ifade, sagda overlayde korunacak yazi",
  "backend=backend",
  "frontend=frontend",
  "full stack=full stack",
  "Spring Boot=Spring Boot",
  "REST API=REST API",
  "API=API",
  "JWT=JWT",
  "JSON=JSON",
  "endpoint=endpoint",
  "controller=controller",
  "annotation=annotation",
  "repository=repository",
  "Postman=Postman",
  "dependency injection=dependency injection",
  "path variable=path variable",
  "request body=request body",
  "exception handler=exception handler"
].join("\n");

const DEFAULT_SETTINGS = {
  deeplApiKey: "",
  deeplUsePro: false,
  targetLang: "TR",
  sourceLangHint: "EN",
  preferExistingSubtitles: true,
  enableDubbing: true,
  ttsProvider: "browser",
  sttProvider: "openai",
  openaiApiKey: "",
  openaiSttModel: "gpt-4o-mini-transcribe",
  openaiTtsModel: "gpt-4o-mini-tts",
  openaiVoice: "coral",
  browserVoiceURI: "",
  browserVoiceName: "",
  openaiTtsInstructions: "Speak fluent Turkish in a calm educational tone. When you encounter English software terms, pronounce them the way a Turkish developer would naturally say them. Examples: backend -> bekent, frontend -> frontent, Spring Boot -> spring but, REST API -> rest ey pi ay, JWT -> cey dabilyu ti.",
  pronunciationGlossary: DEFAULT_PRONUNCIATION_GLOSSARY,
  technicalGlossary: DEFAULT_TECHNICAL_GLOSSARY,
  strictCaptionMode: true,
  syncDubbing: true,
  preferSentenceCompletion: true,
  interruptToleranceMs: 1200,
  ttsMaxRate: 2.25,
  duckingVolume: 0.18,
  showSourceText: true,
  overlayCompact: false
};

const translationCache = new Map();
const speechCache = new Map();
const recentSegmentKeys = new Map();
const pendingTtsRequests = new Map();
const sttSeqCounters = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get();
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stopSession(tabId, true).catch(() => {});
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePronunciationGlossary(glossaryText) {
  return String(glossaryText || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      const source = normalizeText(line.slice(0, index));
      const target = normalizeText(line.slice(index + 1));
      return source && target ? { source, target } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.source.length - a.source.length);
}

function parseTechnicalGlossary(glossaryText) {
  return String(glossaryText || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      const source = normalizeText(line.slice(0, index));
      const display = normalizeText(line.slice(index + 1));
      return source && display ? { source, display } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.source.length - a.source.length);
}

function protectTechnicalTerms(text, glossaryText) {
  const sourceText = normalizeText(text);
  const rules = parseTechnicalGlossary(glossaryText);
  if (!sourceText || !rules.length) {
    return { protectedText: sourceText, placeholders: [] };
  }

  let protectedText = sourceText;
  const placeholders = [];
  for (const rule of rules) {
    const token = `ZXQTERM${placeholders.length}ZXQ`;
    const pattern = new RegExp(`(?<![\p{L}\p{N}])${escapeRegExp(rule.source)}(?![\p{L}\p{N}])`, "giu");
    if (pattern.test(protectedText)) {
      protectedText = protectedText.replace(pattern, token);
      placeholders.push({ token, display: rule.display, source: rule.source });
    }
  }

  return { protectedText, placeholders };
}

function restoreTechnicalTerms(text, placeholders) {
  let result = normalizeText(text);
  for (const item of placeholders || []) {
    result = result.replace(new RegExp(escapeRegExp(item.token), "g"), item.display);
  }
  return normalizeText(result);
}

function applyPronunciationGlossary(text, glossaryText) {
  let result = normalizeText(text);
  if (!result) {
    return "";
  }

  for (const rule of parsePronunciationGlossary(glossaryText)) {
    const source = escapeRegExp(rule.source);
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`, "giu");
    result = result.replace(pattern, rule.target);
  }

  return normalizeText(result);
}

function buildSpeechText(translatedText, settings) {
  const baseText = normalizeText(translatedText);
  if (!baseText) {
    return "";
  }
  return applyPronunciationGlossary(baseText, settings.pronunciationGlossary || DEFAULT_PRONUNCIATION_GLOSSARY);
}

function getSessionStorageKey(tabId) {
  return `session_${tabId}`;
}

async function setSession(tabId, session) {
  await chrome.storage.session.set({ [getSessionStorageKey(tabId)]: session });
}

async function getSession(tabId) {
  const key = getSessionStorageKey(tabId);
  const result = await chrome.storage.session.get(key);
  return result[key] || null;
}

async function clearSession(tabId) {
  await chrome.storage.session.remove(getSessionStorageKey(tabId));
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  if (!settings.deeplApiKey && stored.deeplApiKey) {
    settings.deeplApiKey = stored.deeplApiKey;
  }
  return settings;
}

async function sendTabMessage(tabId, payload, frameId = null) {
  const options = frameId === null || frameId === undefined ? undefined : { frameId };
  return chrome.tabs.sendMessage(tabId, payload, options);
}

function shouldSkipRecent(tabId, dedupeKey, windowMs = 4000) {
  const key = `${tabId}:${dedupeKey}`;
  const now = Date.now();
  const previous = recentSegmentKeys.get(key) || 0;
  recentSegmentKeys.set(key, now);
  for (const [mapKey, timestamp] of recentSegmentKeys.entries()) {
    if (now - timestamp > windowMs * 2) {
      recentSegmentKeys.delete(mapKey);
    }
  }
  return now - previous < windowMs;
}

async function ensureContentInjected(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId, allFrames: true },
    files: ["content.css"]
  }).catch(() => {});

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"]
  }).catch((error) => {
    console.debug("content injection skipped", error);
  });
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) {
      return;
    }
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture Udemy tab audio for speech to text fallback and dubbing."
  });
}

function pageProbeFunction() {
  function normalizeInner(text) {
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

  function getVideoRect(video) {
    const rect = video?.getBoundingClientRect?.();
    if (!rect) {
      return null;
    }
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function scoreCaptionElement(element, videoRect) {
    if (!isVisibleElement(element)) {
      return -Infinity;
    }

    const text = normalizeInner(element.innerText || element.textContent || "");
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
    } else if (rect.top > window.innerHeight * 0.25) {
      score += 6;
    }

    return score;
  }

  function findCaptionElement(video = null) {
    const selectors = [
      "[data-purpose*='caption' i]",
      "[data-purpose*='subtitle' i]",
      "[class*='caption' i]",
      "[class*='subtitle' i]",
      "[aria-live='assertive']",
      "[aria-live='polite']"
    ];
    const videoRect = getVideoRect(video);
    const candidates = [];
    for (const selector of selectors) {
      candidates.push(...queryAllDeep(selector));
    }
    const ranked = candidates
      .map((element) => ({ element, score: scoreCaptionElement(element, videoRect) }))
      .filter((item) => Number.isFinite(item.score) && item.score > 20)
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.element || null;
  }

  const video = findVideo();
  const tracks = Array.from(video?.textTracks || []).map((track, index) => ({
    index,
    kind: track.kind || "",
    label: track.label || "",
    language: track.language || "",
    mode: track.mode || "disabled"
  }));
  const captionEl = findCaptionElement(video);

  return {
    href: location.href,
    title: document.title,
    hasVideo: Boolean(video),
    hasUsableTextTrack: tracks.length > 0,
    hasDomCaptions: Boolean(captionEl),
    tracks,
    captionSample: captionEl ? normalizeInner(captionEl.innerText || captionEl.textContent || "").slice(0, 140) : "",
    videoRect: getVideoRect(video)
  };
}

function scoreProbe(probe) {
  if (!probe) {
    return -Infinity;
  }
  let score = 0;
  if (probe.hasVideo) {
    score += 100;
    const area = Number(probe.videoRect?.width || 0) * Number(probe.videoRect?.height || 0);
    score += Math.min(60, area / 50000);
  }
  if (probe.hasUsableTextTrack) score += 60;
  if (probe.hasDomCaptions) score += 28;
  if (probe.captionSample) score += 8;
  if (probe.frameId === 0) score += 2;
  return score;
}

async function probeAllFrames(tabId) {
  await ensureContentInjected(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: pageProbeFunction
  });

  const frames = results
    .map((entry) => ({
      frameId: entry.frameId,
      documentId: entry.documentId,
      ...(entry.result || {})
    }))
    .filter((probe) => probe && (probe.hasVideo || probe.hasUsableTextTrack || probe.hasDomCaptions || probe.href));

  const ranked = frames
    .map((probe) => ({ probe, score: scoreProbe(probe) }))
    .sort((a, b) => b.score - a.score);

  return {
    frames,
    best: ranked[0]?.probe || null
  };
}

function getDeepLEndpoint(settings) {
  if (settings.deeplUsePro) {
    return "https://api.deepl.com/v2/translate";
  }
  return "https://api-free.deepl.com/v2/translate";
}

async function translateText(text, settings) {
  const sourceText = normalizeText(text);
  if (!sourceText) {
    return "";
  }

  const protectedTerms = protectTechnicalTerms(sourceText, settings.technicalGlossary || DEFAULT_TECHNICAL_GLOSSARY);
  const protectedText = normalizeText(protectedTerms.protectedText || sourceText);
  const cacheKey = `${settings.targetLang}::${settings.sourceLangHint || "AUTO"}::${protectedText}`;
  if (translationCache.has(cacheKey)) {
    return restoreTechnicalTerms(translationCache.get(cacheKey), protectedTerms.placeholders);
  }
  if (!settings.deeplApiKey) {
    return restoreTechnicalTerms(sourceText, protectedTerms.placeholders);
  }

  const payload = {
    text: [protectedText],
    target_lang: settings.targetLang,
    preserve_formatting: true,
    split_sentences: "nonewlines"
  };
  if (settings.sourceLangHint) {
    payload.source_lang = settings.sourceLangHint;
  }

  const response = await fetch(getDeepLEndpoint(settings), {
    method: "POST",
    headers: {
      "Authorization": `DeepL-Auth-Key ${settings.deeplApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`DeepL translation failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  const translated = normalizeText(data?.translations?.[0]?.text || protectedText);
  translationCache.set(cacheKey, translated);
  return restoreTechnicalTerms(translated, protectedTerms.placeholders);
}

function mimeTypeToExtension(mimeType) {
  const mime = String(mimeType || "audio/webm").toLowerCase();
  if (mime.includes("webm")) return "webm";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "webm";
}

async function transcribeAudio(bytes, mimeType, settings) {
  if (!settings.openaiApiKey) {
    throw new Error("OpenAI API key missing for STT fallback.");
  }

  const audioBlob = new Blob([bytes], { type: mimeType || "audio/webm" });
  const formData = new FormData();
  formData.append("file", audioBlob, `segment.${mimeTypeToExtension(mimeType)}`);
  formData.append("model", settings.openaiSttModel || "gpt-4o-mini-transcribe");
  formData.append("response_format", "text");
  if (settings.sourceLangHint) {
    formData.append("language", String(settings.sourceLangHint).toLowerCase());
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.openaiApiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${await response.text()}`);
  }

  return normalizeText(await response.text());
}

function computeTtsSpeed(text, durationMs, settings) {
  const maxRate = clamp(Number(settings?.ttsMaxRate || 2.25), 1, 3);
  if (!durationMs || durationMs < 500) {
    return 1;
  }
  const words = Math.max(1, normalizeText(text).split(/\s+/).length);
  const seconds = Math.max(0.45, durationMs / 1000);
  const wordsPerSecond = words / seconds;
  return clamp(wordsPerSecond / 2.45, 0.95, maxRate);
}

async function synthesizeSpeech(text, settings, durationMs, signal) {
  if (!settings.openaiApiKey) {
    throw new Error("OpenAI API key missing for TTS.");
  }
  const inputText = normalizeText(text).slice(0, 4000);
  const cacheKey = `${settings.openaiTtsModel}|${settings.openaiVoice}|${durationMs || 0}|${inputText}`;
  if (speechCache.has(cacheKey)) {
    return speechCache.get(cacheKey);
  }

  const payload = {
    model: settings.openaiTtsModel || "gpt-4o-mini-tts",
    voice: settings.openaiVoice || "coral",
    input: inputText,
    response_format: "mp3",
    speed: computeTtsSpeed(inputText, durationMs, settings)
  };

  if ((settings.openaiTtsModel || "").startsWith("gpt-4o-mini-tts") && settings.openaiTtsInstructions) {
    payload.instructions = settings.openaiTtsInstructions;
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    throw new Error(`OpenAI speech failed (${response.status}): ${await response.text()}`);
  }

  const audioBytes = await response.arrayBuffer();
  speechCache.set(cacheKey, audioBytes);
  return audioBytes;
}

async function prepareDub(tabId, frameId, requestId, isLookahead, sourceText, translatedText, speechText, timing, settings) {
  const durationMs = Math.max(0, Number(timing?.durationMs || 0));
  const startTime = Number.isFinite(Number(timing?.startTime)) ? Number(timing.startTime) : null;
  const endTime = Number.isFinite(Number(timing?.endTime)) ? Number(timing.endTime) : null;

  const basePayload = {
    type: "prepare-dub",
    requestId,
    isLookahead,
    sourceText,
    translatedText,
    speechText,
    durationMs,
    startTime,
    endTime,
    settings
  };

  const provider = settings.ttsProvider || "browser";
  if (!settings.enableDubbing || provider === "off") {
    await sendTabMessage(tabId, { ...basePayload, kind: "off" }, frameId);
    return;
  }

  if (provider === "openai" && settings.openaiApiKey) {
    await sendTabMessage(tabId, { ...basePayload, kind: "openai" }, frameId);

    const pendingKey = `${tabId}:${requestId}`;
    const controller = new AbortController();
    pendingTtsRequests.set(pendingKey, controller);

    synthesizeSpeech(speechText || translatedText, settings, durationMs, controller.signal)
      .then((audioBytes) => {
        if (pendingTtsRequests.get(pendingKey) !== controller) {
          return null;
        }
        pendingTtsRequests.delete(pendingKey);
        return sendTabMessage(tabId, { type: "tts-ready", requestId, audioBytes }, frameId);
      })
      .catch((error) => {
        if (pendingTtsRequests.get(pendingKey) === controller) {
          pendingTtsRequests.delete(pendingKey);
        }
        if (error?.name === "AbortError") {
          return null;
        }
        console.warn("OpenAI TTS failed, falling back to browser TTS.", error);
        return sendTabMessage(tabId, { type: "tts-error", requestId }, frameId);
      })
      .catch(() => {});
    return;
  }

  await sendTabMessage(tabId, { ...basePayload, kind: "browser" }, frameId);
}

async function handleSubtitleSegment(tabId, frameId, payload) {
  const session = await getSession(tabId);
  if (!session) {
    return { ok: false, reason: "no-session" };
  }
  if (session.frameId !== undefined && session.frameId !== null && frameId !== session.frameId) {
    return { ok: false, reason: "wrong-frame" };
  }

  const settings = { ...DEFAULT_SETTINGS, ...(session.settingsSnapshot || {}) };
  const sourceText = normalizeText(payload.text);
  if (!sourceText) {
    return { ok: false, reason: "empty" };
  }

  const origin = payload.origin === "dom" ? "dom" : "subtitle";
  const isLookahead = Boolean(payload.isLookahead);
  const requestId = payload.requestId;
  const timeKey = Math.round((payload.startTime || 0) * 10);
  const dedupeKey = `${isLookahead ? "lookahead:" : ""}${origin}|${timeKey}|${sourceText}`;
  if (shouldSkipRecent(tabId, dedupeKey)) {
    return { ok: true, skipped: true };
  }

  const translatedText = await translateText(sourceText, settings);
  const speechText = buildSpeechText(translatedText, settings);
  const playbackRate = clamp(Number(payload.playbackRate || 1), 0.25, 4);
  const durationMs = Math.max(0, (((payload.endTime || 0) - (payload.startTime || 0)) * 1000) / playbackRate);

  if (!isLookahead) {
    await sendTabMessage(tabId, {
      type: "translated-segment",
      requestId,
      origin,
      sourceText,
      translatedText,
      speechText,
      startTime: payload.startTime || 0,
      endTime: payload.endTime || 0,
      settings
    }, session.frameId);
  }

  await prepareDub(tabId, session.frameId, requestId, isLookahead, sourceText, translatedText, speechText, {
    durationMs,
    startTime: payload.startTime || 0,
    endTime: payload.endTime || 0
  }, settings).catch((error) => console.error(error));

  return { ok: true };
}

async function handleAudioSegment(tabId, payload) {
  const session = await getSession(tabId);
  if (!session) {
    return { ok: false, reason: "no-session" };
  }
  const settings = { ...DEFAULT_SETTINGS, ...(session.settingsSnapshot || {}) };
  const transcript = normalizeText(await transcribeAudio(payload.bytes, payload.mimeType, settings));
  if (!transcript) {
    return { ok: true, skipped: true };
  }

  const dedupeKey = `stt|${transcript.toLowerCase()}`;
  if (shouldSkipRecent(tabId, dedupeKey, 5000)) {
    return { ok: true, skipped: true };
  }

  const translatedText = await translateText(transcript, settings);
  const speechText = buildSpeechText(translatedText, settings);

  const requestId = (sttSeqCounters.get(tabId) || 0) + 1;
  sttSeqCounters.set(tabId, requestId);

  await sendTabMessage(tabId, {
    type: "translated-segment",
    requestId,
    origin: "stt",
    sourceText: transcript,
    translatedText,
    speechText,
    approxDurationMs: payload.approxDurationMs || 0,
    settings
  }, session.frameId);

  await prepareDub(tabId, session.frameId, requestId, false, transcript, translatedText, speechText, {
    durationMs: payload.approxDurationMs || 0
  }, settings).catch((error) => console.error(error));

  return { ok: true };
}

function chooseMode(probe, settings) {
  const canUseStt = settings.sttProvider === "openai" && Boolean(settings.openaiApiKey);
  const hasSubtitleSource = Boolean(probe?.hasUsableTextTrack || probe?.hasDomCaptions);

  if (settings.preferExistingSubtitles && probe?.hasUsableTextTrack) {
    return "track";
  }
  if (settings.preferExistingSubtitles && probe?.hasDomCaptions) {
    return "dom";
  }
  if (canUseStt) {
    return "stt";
  }
  if (probe?.hasUsableTextTrack) {
    return "track";
  }
  if (probe?.hasDomCaptions) {
    return "dom";
  }
  if (!hasSubtitleSource && canUseStt) {
    return "stt";
  }
  return null;
}

async function startSession(tabId) {
  await ensureContentInjected(tabId);
  const settings = await getSettings();
  const inspection = await probeAllFrames(tabId);
  const probe = inspection.best;

  if (!probe) {
    throw new Error("Udemy playeri tespit edilemedi. Sekmeyi yenileyip tekrar deneyin.");
  }

  const mode = chooseMode(probe, settings);
  const canUseStt = settings.sttProvider === "openai" && Boolean(settings.openaiApiKey);

  if (!mode) {
    throw new Error("Bu derste erisilebilir altyazi kaynagi bulunamadi. OpenAI API key ile STT fallback acin veya altyaziyi ders oynaticisinda etkinlestirin.");
  }

  if (mode === "stt") {
    if (!canUseStt) {
      throw new Error("Bu derste erisilebilir altyazi kaynagi bulunamadi. STT fallback icin OpenAI API key ekleyin.");
    }
    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "offscreen-start-capture",
      tabId,
      streamId,
      vad: {
        threshold: 0.018,
        silenceMs: 900,
        minSpeechMs: 900,
        maxSegmentMs: 12000,
        timesliceMs: 1000,
        preRollBlobs: 2
      }
    });
  } else {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "offscreen-stop-capture",
      tabId
    }).catch(() => {});
  }

  const session = {
    tabId,
    frameId: probe.frameId,
    mode,
    startedAt: Date.now(),
    settingsSnapshot: settings,
    probeSnapshot: probe
  };

  await setSession(tabId, session);
  await sendTabMessage(tabId, {
    type: "session-start",
    mode,
    settings,
    probe
  }, probe.frameId);

  return { ok: true, mode, probe, framesScanned: inspection.frames.length };
}

async function stopSession(tabId, silent = false) {
  const session = await getSession(tabId);

  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "offscreen-stop-capture",
    tabId
  }).catch(() => {});

  const prefix = `${tabId}:`;
  for (const [key, controller] of pendingTtsRequests.entries()) {
    if (key.startsWith(prefix)) {
      controller.abort();
      pendingTtsRequests.delete(key);
    }
  }
  sttSeqCounters.delete(tabId);

  if (!silent && session) {
    await sendTabMessage(tabId, { type: "session-stop" }, session.frameId).catch(() => {});
  }
  await clearSession(tabId);
  return { ok: true };
}

async function getStatus(tabId) {
  await ensureContentInjected(tabId);
  const [settings, session, inspection] = await Promise.all([
    getSettings(),
    getSession(tabId),
    probeAllFrames(tabId).catch(() => ({ best: null, frames: [] }))
  ]);

  const probe = session?.probeSnapshot || inspection.best || null;
  let contentState = null;

  if (probe?.frameId !== undefined && probe?.frameId !== null) {
    try {
      contentState = await sendTabMessage(tabId, { type: "content-state" }, probe.frameId);
    } catch (error) {
      contentState = null;
    }
  }

  return {
    ok: true,
    session,
    probe,
    framesScanned: inspection.frames.length,
    contentState,
    config: {
      hasDeepLKey: Boolean(settings.deeplApiKey),
      hasOpenAIKey: Boolean(settings.openaiApiKey),
      ttsProvider: settings.ttsProvider,
      sttProvider: settings.sttProvider,
      enableDubbing: settings.enableDubbing,
      preferExistingSubtitles: settings.preferExistingSubtitles
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "popup-start-session":
        sendResponse(await startSession(message.tabId));
        return;
      case "popup-stop-session":
        sendResponse(await stopSession(message.tabId));
        return;
      case "popup-get-status":
        sendResponse(await getStatus(message.tabId));
        return;
      case "content-subtitle-segment":
        sendResponse(await handleSubtitleSegment(sender.tab.id, sender.frameId, message));
        return;
      case "tts-cancel": {
        const pendingKey = `${sender.tab.id}:${message.requestId}`;
        pendingTtsRequests.get(pendingKey)?.abort();
        pendingTtsRequests.delete(pendingKey);
        sendResponse({ ok: true });
        return;
      }
      case "offscreen-audio-segment":
        sendResponse(await handleAudioSegment(message.tabId, message));
        return;
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
        return;
    }
  })().catch((error) => {
    console.error(error);
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});
