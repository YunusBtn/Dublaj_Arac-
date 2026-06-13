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

function $(id) {
  return document.getElementById(id);
}

function updateDuckingLabel() {
  $("duckingValue").textContent = Number($("duckingVolume").value).toFixed(2);
}

function updateTtsMaxRateLabel() {
  $("ttsMaxRateValue").textContent = Number($("ttsMaxRate").value).toFixed(2);
}

function updateInterruptToleranceLabel() {
  $("interruptToleranceMsValue").textContent = `${Math.round(Number($("interruptToleranceMs").value))} ms`;
}

function getVoiceLabel(voice) {
  const parts = [voice.name || "Unnamed", voice.lang || ""];
  if (voice.default) {
    parts.push("default");
  }
  return parts.filter(Boolean).join(" - ");
}

function populateBrowserVoices(selectedUri = "", selectedName = "") {
  const select = $("browserVoiceURI");
  if (!select) {
    return;
  }

  const currentValue = selectedUri || select.value || "";
  const voices = Array.from(window.speechSynthesis?.getVoices?.() || []);
  const preferredVoices = voices
    .filter((voice) => String(voice.lang || "").toLowerCase().startsWith("tr"))
    .sort((a, b) => getVoiceLabel(a).localeCompare(getVoiceLabel(b)));
  const fallbackVoices = voices
    .filter((voice) => !String(voice.lang || "").toLowerCase().startsWith("tr"))
    .sort((a, b) => getVoiceLabel(a).localeCompare(getVoiceLabel(b)));
  const allVoices = [...preferredVoices, ...fallbackVoices];

  select.innerHTML = "";
  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "Otomatik Turkce sistem sesi";
  select.appendChild(autoOption);

  for (const voice of allVoices) {
    const option = document.createElement("option");
    option.value = String(voice.voiceURI || voice.name || "");
    option.textContent = getVoiceLabel(voice);
    option.dataset.voiceName = String(voice.name || "");
    select.appendChild(option);
  }

  const wanted = Array.from(select.options).find((option) => option.value === currentValue)
    || Array.from(select.options).find((option) => option.dataset.voiceName === selectedName)
    || select.options[0];
  if (wanted) {
    select.value = wanted.value;
  }
}

function updateProviderVisibility() {
  const ttsProvider = $("ttsProvider").value;
  $("browserVoiceURI").disabled = ttsProvider !== "browser";
  $("openaiTtsModel").disabled = ttsProvider !== "openai";
  $("openaiVoice").disabled = ttsProvider !== "openai";
  $("openaiTtsInstructions").disabled = ttsProvider !== "openai";
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  populateBrowserVoices(settings.browserVoiceURI || "", settings.browserVoiceName || "");
  $("deeplApiKey").value = settings.deeplApiKey || "";
  $("deeplUsePro").checked = Boolean(settings.deeplUsePro);
  $("sourceLangHint").value = settings.sourceLangHint || "";
  $("preferExistingSubtitles").checked = Boolean(settings.preferExistingSubtitles);
  $("showSourceText").checked = Boolean(settings.showSourceText);
  $("openaiApiKey").value = settings.openaiApiKey || "";
  $("sttProvider").value = settings.sttProvider || "openai";
  $("openaiSttModel").value = settings.openaiSttModel || "gpt-4o-mini-transcribe";
  $("ttsProvider").value = settings.ttsProvider || "browser";
  $("openaiTtsModel").value = settings.openaiTtsModel || "gpt-4o-mini-tts";
  $("openaiVoice").value = settings.openaiVoice || "coral";
  $("openaiTtsInstructions").value = settings.openaiTtsInstructions || DEFAULT_SETTINGS.openaiTtsInstructions;
  $("enableDubbing").checked = Boolean(settings.enableDubbing);
  $("overlayCompact").checked = Boolean(settings.overlayCompact);
  $("syncDubbing").checked = settings.syncDubbing !== false;
  $("preferSentenceCompletion").checked = settings.preferSentenceCompletion !== false;
  $("pronunciationGlossary").value = settings.pronunciationGlossary || DEFAULT_PRONUNCIATION_GLOSSARY;
  $("technicalGlossary").value = settings.technicalGlossary || DEFAULT_TECHNICAL_GLOSSARY;
  $("strictCaptionMode").checked = settings.strictCaptionMode !== false;
  $("ttsMaxRate").value = Number(settings.ttsMaxRate || 2.25);
  $("interruptToleranceMs").value = Number(settings.interruptToleranceMs || 1200);
  $("duckingVolume").value = Number(settings.duckingVolume || 0.18);
  updateTtsMaxRateLabel();
  updateInterruptToleranceLabel();
  updateDuckingLabel();
  updateProviderVisibility();
}

async function saveSettings() {
  const deeplApiKey = $("deeplApiKey").value.trim();
  let deeplUsePro = $("deeplUsePro").checked;
  if (deeplApiKey.endsWith(":fx")) {
    deeplUsePro = false;
  }

  const selectedBrowserOption = $("browserVoiceURI").selectedOptions[0] || null;
  const payload = {
    deeplApiKey,
    deeplUsePro,
    targetLang: "TR",
    sourceLangHint: $("sourceLangHint").value,
    preferExistingSubtitles: $("preferExistingSubtitles").checked,
    showSourceText: $("showSourceText").checked,
    openaiApiKey: $("openaiApiKey").value.trim(),
    sttProvider: $("sttProvider").value,
    openaiSttModel: $("openaiSttModel").value,
    ttsProvider: $("ttsProvider").value,
    openaiTtsModel: $("openaiTtsModel").value,
    openaiVoice: $("openaiVoice").value,
    browserVoiceURI: $("browserVoiceURI").value,
    browserVoiceName: selectedBrowserOption?.dataset?.voiceName || "",
    openaiTtsInstructions: $("openaiTtsInstructions").value.trim(),
    pronunciationGlossary: $("pronunciationGlossary").value.trim() || DEFAULT_PRONUNCIATION_GLOSSARY,
    technicalGlossary: $("technicalGlossary").value.trim() || DEFAULT_TECHNICAL_GLOSSARY,
    strictCaptionMode: $("strictCaptionMode").checked,
    enableDubbing: $("enableDubbing").checked,
    overlayCompact: $("overlayCompact").checked,
    syncDubbing: $("syncDubbing").checked,
    preferSentenceCompletion: $("preferSentenceCompletion").checked,
    interruptToleranceMs: Number($("interruptToleranceMs").value),
    ttsMaxRate: Number($("ttsMaxRate").value),
    duckingVolume: Number($("duckingVolume").value)
  };

  await chrome.storage.sync.set(payload);
  $("saveStatus").textContent = "Kaydedildi.";
  setTimeout(() => {
    $("saveStatus").textContent = "";
  }, 1500);
}

$("saveBtn").addEventListener("click", () => {
  void saveSettings();
});

$("duckingVolume").addEventListener("input", updateDuckingLabel);
$("ttsMaxRate").addEventListener("input", updateTtsMaxRateLabel);
$("interruptToleranceMs").addEventListener("input", updateInterruptToleranceLabel);
$("ttsProvider").addEventListener("change", updateProviderVisibility);

try {
  populateBrowserVoices();
  window.speechSynthesis?.addEventListener?.("voiceschanged", () => {
    populateBrowserVoices($("browserVoiceURI").value);
  });
} catch (error) {
  console.debug("voice list init skipped", error);
}

void loadSettings();
