function $(id) {
  return document.getElementById(id);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function renderIssues(list) {
  const issuesEl = $("issues");
  issuesEl.innerHTML = "";
  for (const issue of list) {
    const li = document.createElement("li");
    li.textContent = issue;
    issuesEl.appendChild(li);
  }
}

function renderPopupError(message) {
  $("statusLine").textContent = message || "Baslatma basarisiz.";
}

async function refreshStatus() {
  const tab = await getActiveTab();
  if (!tab) {
    $("statusLine").textContent = "Aktif tab bulunamadi.";
    $("details").textContent = "";
    renderIssues([]);
    return;
  }

  let hostname = "";
  try {
    hostname = new URL(tab.url || "").hostname;
  } catch (error) {
    hostname = "";
  }

  if (!hostname.includes("udemy.com")) {
    $("statusLine").textContent = "Bu uzanti sadece Udemy sayfalarinda calisir.";
    $("details").textContent = hostname || "Udemy sayfasina gidin.";
    renderIssues([]);
    return;
  }

  const status = await chrome.runtime.sendMessage({ type: "popup-get-status", tabId: tab.id });
  if (!status?.ok) {
    renderPopupError(status?.error || "Durum okunamadi.");
    $("details").textContent = "";
    renderIssues([]);
    return;
  }

  const issues = [];
  if (!status.config?.hasDeepLKey) {
    issues.push("DeepL key yok. Ceviri icin gerekli.");
  }
  if (!status.probe?.hasUsableTextTrack && !status.probe?.hasDomCaptions && !status.config?.hasOpenAIKey) {
    issues.push("Subtitle kaynagi gorunmuyor. OpenAI key ile STT fallback gerekir.");
  }
  if (status.config?.enableDubbing && status.config?.ttsProvider === "openai" && !status.config?.hasOpenAIKey) {
    issues.push("OpenAI TTS secili ama OpenAI key eksik. Browser TTS fallback kullanilir.");
  }
  if (!status.probe?.hasVideo && !status.probe?.hasDomCaptions && !status.probe?.hasUsableTextTrack) {
    issues.push("Player henuz algilanmadiysa sekmeyi bir kez yenileyin.");
  }

  const modeText = status.session?.mode ? `Calisiyor: ${status.session.mode}` : "Su an duruyor";
  const trackCount = status.probe?.tracks?.length || 0;
  const domCaptionText = status.probe?.hasDomCaptions ? "var" : "yok";
  $("statusLine").textContent = modeText;
  $("details").textContent = `Video: ${status.probe?.hasVideo ? "var" : "yok"} | Text track: ${trackCount} | DOM caption: ${domCaptionText} | Frame: ${status.framesScanned || 0} | Dublaj: ${status.config?.enableDubbing ? "acik" : "kapali"}`;
  renderIssues(issues);
}

$("startBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "popup-start-session", tabId: tab.id });
  if (!result?.ok) {
    renderPopupError(result?.error || "Baslatma basarisiz.");
    return;
  }
  await refreshStatus();
});

$("stopBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return;
  }
  await chrome.runtime.sendMessage({ type: "popup-stop-session", tabId: tab.id });
  await refreshStatus();
});

$("optionsBtn").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

void refreshStatus();
