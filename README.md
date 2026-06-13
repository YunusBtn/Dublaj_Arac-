# Udemy TR Dub v0.1.5

Bu surumde iki ana sorun iyilestirildi:
- Teknik terimler icin ceviri-koruma ve ayri telaffuz akisi
- Altyazi gorunmuyorken sayfadaki baska metinleri caption sanmayi azaltan strict caption mode

## Yeni ayarlar
- Teknik terim koruma: ceviride Ingilizce kalmasini istedigin terimler
- Strict caption mode: altyazi gorunmuyor ise diger DOM metinlerini caption gibi okumamaya calisir

# Udemy TR Dub (Chrome MV3 prototype)

This is a personal-use Chrome extension prototype for Udemy lessons.

## What it does

1. Tries to read an existing subtitle/text track from the Udemy player.
2. Sends the English subtitle text to DeepL and renders a Turkish overlay.
3. If dubbing is enabled, it speaks the Turkish text using either:
   - Browser TTS (fastest, no extra TTS key needed), or
   - OpenAI TTS (better quality if you add an OpenAI key).
4. If no accessible text track is available, it falls back to tab-audio capture and OpenAI speech-to-text.

## Requirements

- Chrome 116+
- DeepL API key for translation
- Optional OpenAI API key for:
  - no-subtitle STT fallback
  - higher quality TTS dubbing

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder
5. Open the extension options page and paste your keys

## Suggested settings

- If a lesson already has English captions:
  - DeepL key is enough for Turkish subtitles
  - Browser TTS is enough for a first pass
- If a lesson has no usable subtitles:
  - add OpenAI key
  - keep `STT provider = OpenAI`

## How it behaves

### Mode A: existing subtitle track

The content script watches `video.textTracks` and listens for active cue changes.
When a new segment arrives:

- text is normalized
- translated with DeepL
- shown in overlay
- optionally spoken in Turkish

### Mode B: no accessible subtitle track

The service worker starts `chrome.tabCapture` and an offscreen document consumes the stream.
The offscreen document:

- restores local audio playback
- runs a light RMS/VAD gate
- groups speech into short segments
- sends each segment to OpenAI transcription
- translates the transcript with DeepL
- sends Turkish text back to the page

## Current limitations

- Udemy DOM/player details can change. This extension avoids hardcoded Udemy DOM selectors as much as possible and prefers generic `video.textTracks` plus tab-audio fallback.
- Browser TTS quality depends on OS/browser voices.
- OpenAI TTS is better, but still not perfect for tight lip sync.
- Audio fallback is near-live, not true zero-latency realtime.
- Very fast speech may still cause overlap or backlog in dubbing.
- Service-worker lifecycle in MV3 is handled well enough for a prototype, but a production-grade build should add more persistent session management and richer observability.

## Security note

DeepL explicitly warns against using API keys in publicly distributed client-side code.
This prototype stores keys in extension storage for personal local use only.
If you want to publish or share this widely, move API access behind a user-owned backend or local bridge.

## Production hardening ideas

- Replace direct API calls with a local bridge or private backend.
- Add transcript export (`.srt` / `.vtt`).
- Add selectable Turkish voices and speaking speed profiles.
- Add smarter segment alignment and overlap handling.
- Add optional per-course translation cache.
- Add side-panel UI and session logs.

## Files

- `manifest.json` - MV3 manifest
- `background.js` - orchestration, DeepL/OpenAI calls, session control
- `offscreen.js` - tab audio capture and VAD segmentation
- `content.js` - overlay, subtitle-track reading, browser playback
- `popup.*` - quick controls
- `options.*` - API keys and behavior settings


## v0.1.2 fixes

- Added automatic content-script injection for already-open Udemy tabs, so a manual full reload is less often needed.
- Added all-frame support plus `match_origin_as_fallback`, which helps when the player or captions live inside a related frame.
- Added a DOM-caption mode for lessons where English captions are visible on screen but `video.textTracks` is empty.
- Fixed popup behavior so start errors are shown instead of being immediately overwritten.

## Troubleshooting

- If the popup says `Video: yok` but you can clearly see the lesson, click refresh on the Udemy tab once after updating the extension.
- If `Text track: 0` but English captions are visible on the player, the extension should now fall back to DOM-caption mode automatically.
- If there are no visible captions at all, add an OpenAI key to enable STT fallback.


## 0.1.2 notlari

- Browser TTS icin sistem ses secimi eklendi.
- OpenAI TTS ile Browser TTS alanlari ayarlarda ayrildi.
- Teknik terimler icin seslendirme sozlugu eklendi. Overlay metni ayni kalirken dublaj metni farkli okunabilir.


## v0.1.4 sync update

- Dublaj artik video `playbackRate` degerini hesaba katar.
- Gec kalan TTS kuyrugu buyumez; eski parcalar kesilip en guncel altyaziya yetismeye calisilir.
- Ayarlara `sync dubbing` ve `tts max rate` eklendi.


## 0.1.4

- 2x gibi hizlarda cumleyi yarim kesmeyi azaltan akilli cumle tamamlama modu eklendi.
- Yeni altyazi gelince mevcut cumleye taninan ek sure ayari eklendi.
- Senkron modda ara altyazilar yerine en guncel altyaziya atlama davranisi korundu.
