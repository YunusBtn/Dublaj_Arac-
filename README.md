# Udemy TR Dub

İngilizce Udemy derslerini gerçek zamanlı Türkçe çeviri ve dublajla izlemenizi sağlayan kişisel kullanım amaçlı Chrome uzantısı.

![Version](https://img.shields.io/badge/version-0.1.5-blue)
![Chrome](https://img.shields.io/badge/Chrome-116%2B-green)
![License](https://img.shields.io/badge/license-personal%20use-orange)

---

## Ne Yapar?

- İngilizce altyazıyı otomatik olarak Türkçeye çevirir ve ekranda overlay olarak gösterir
- İsteğe bağlı olarak Türkçe metni sesli okur (dublaj yapar)
- Teknik terimleri (backend, API, Docker...) çeviriden korur, İngilizce olarak gösterir
- Altyazı olmayan derslerde ses akışını yakalayıp transkript oluşturur

---

## Ekran Görüntüsü

> Ekranda İngilizce altyazı + altında Türkçe overlay + sesli dublaj aynı anda çalışır.

---

## Nasıl Çalışır?

### Mod A — Altyazı track'i varsa

`video.textTracks` üzerinden aktif cue'ları dinler. Her yeni segment geldiğinde:

1. Metin normalize edilir, teknik terimler korunur
2. DeepL ile Türkçeye çevrilir (önbellek destekli)
3. Overlay'de gösterilir
4. Dublaj aktifse TTS ile seslendirilir

Track modunda **lookahead pre-fetch** devreye girer: mevcut cümle çalarken bir sonraki cümlenin sesi arka planda hazırlanır, geçiş anında gecikme sıfıra yakındır.

### Mod B — Altyazı track'i yoksa

`chrome.tabCapture` ile sekme sesi yakalanır. Offscreen belgede:

1. RMS tabanlı VAD (Voice Activity Detection) ile konuşma segmentleri ayrıştırılır
2. Her segment OpenAI Whisper ile metne çevrilir
3. DeepL ile Türkçeye çevrilir
4. Overlay'de gösterilir ve seslendirilebilir

### Mod C — DOM caption modu

`video.textTracks` boş ama ekranda İngilizce altyazı görünüyorsa, DOM'daki caption elementi polling ile izlenir. Strict mode ile sayfa gürültüsü filtrelenir.

---

## Kurulum

1. Bu repoyu ZIP olarak indir veya klonla
2. Chrome'da `chrome://extensions` aç
3. Sağ üstten **Geliştirici modu**nu aç
4. **Paketlenmemiş öğe yükle** → klasörü seç
5. Uzantı simgesine sağ tıkla → **Seçenekler** → API anahtarlarını gir

---

## Gereksinimler

| Servis | Zorunlu mu? | Ne için? |
|--------|-------------|----------|
| DeepL API | ✅ Zorunlu | Türkçe çeviri |
| OpenAI API | ⚡ Önerilen | Kaliteli TTS sesi + altyazısız ders desteği |

### DeepL API Key Alma

1. [deepl.com/pro-api](https://deepl.com/pro-api) adresine git
2. **Developer** planını seç (1 milyon karakter ücretsiz kredi)
3. Hesabından API key kopyala (`:fx` ile biter)

### OpenAI API Key Alma

1. [platform.openai.com](https://platform.openai.com) adresine git
2. API Keys → yeni key oluştur
3. TTS için `gpt-4o-mini-tts` modeli kullanılır (çok ekonomik)

---

## Ayarlar

### Çeviri

| Ayar | Açıklama |
|------|----------|
| DeepL API Key | Çeviri için zorunlu |
| Var olan text track'i önce kullan | Udemy'nin kendi altyazısını tercih et |
| Overlay'de orijinal metni de göster | İngilizce + Türkçe yan yana |
| Strict caption mode | Altyazı yokken sayfa metinlerini caption sanmayı önler |

### Dublaj

| Ayar | Açıklama |
|------|----------|
| Dublaj motoru | Browser TTS (hızlı, ücretsiz) veya OpenAI TTS (kaliteli) |
| OpenAI sesi | nova, onyx, shimmer, coral, fable |
| Maksimum dublaj hız katsayısı | Video hızına göre TTS hızlanır (önerilen: 2.25–3.0) |
| Sync dubbing | Video zamanlamasına göre TTS hızını otomatik ayarla |
| Ducking volume | Dublaj sırasında orijinal ses seviyesi |

### Teknik Terim Koruma

Çeviride İngilizce kalmasını istediğin terimleri tanımlarsın:
```
backend=backend
frontend=frontend
Spring Boot=Spring Boot
REST API=REST API
```

### Telaffuz Sözlüğü

Overlay'de görünen metin aynı kalırken dublajda farklı okunmasını sağlar:
```
backend=bekent
REST API=rest ey pi ay
JWT=cey dabilyu ti
```

---

## Ses Kalitesi İçin Öneriler

**Ücretsiz (Browser TTS):**
- Windows Ayarlar → Zaman ve Dil → Konuşma → Türkçe ses indir
- **Microsoft Tolga** (erkek) veya **Microsoft Emel** (kadın) çok daha doğal
- Chrome'u yeniden başlat, ayarlarda ses seç

**Premium (OpenAI TTS):**
- `nova` — doğal kadın sesi
- `onyx` — derin erkek sesi
- `shimmer` — yumuşak kadın sesi

---

## Mimari

```
manifest.json       MV3 manifest, izinler, host tanımları
background.js       Service worker: DeepL/OpenAI çağrıları, oturum yönetimi,
                    pre-fetch cache, AbortController iptal mantığı
content.js          Sayfa içi: overlay UI, track/DOM/STT mod yönetimi,
                    slot-based TTS scheduler, lookahead pre-fetch,
                    ducking, hız adaptasyonu
offscreen.js        Tab ses yakalama, RMS/VAD, segment gönderimi
popup.html/js       Hızlı başlat/durdur, durum gösterimi
options.html/js     Tüm ayarlar, API key yönetimi, sözlük editörü
content.css         Overlay stilleri
```

### TTS Senkron Mimarisi (v0.1.5+)

Eski kuyruk tabanlı sistemin yerini **slot-based pre-fetch pipeline** aldı:

- Her segment bir **slot** oluşturur (`current` veya `next`)
- Track modunda bir sonraki cue'nun sesi mevcut cümle çalarken arka planda hazırlanır
- Her TTS isteği bir `AbortController`'a bağlıdır, seek/stop anında iptal edilir
- `computeIdealRate`: ses dosyası süresi ÷ cue penceresi = ideal hız (clamp: 1.0–maxRate)
- Kuyruk max 1 slot bekler; lag varsa en güncel cue'ya yetişir

---

## Bilinen Sınırlamalar

- Udemy DOM/player yapısı değişirse bazı modlar etkilenebilir; uzantı mümkün olduğu kadar generic selektörler kullanır
- OpenAI TTS API gecikmesi (~300-500ms) pre-fetch ile gizlenir ama yok edilemez
- STT fallback gerçek zamanlı değil, yakın zamanlıdır
- Çok hızlı konuşmalarda (3x+) senkron zorlanabilir
- MV3 service worker yaşam döngüsü, uzun sessizliklerde oturumu sonlandırabilir

---

## Güvenlik Notu

API anahtarları `chrome.storage.sync` içinde tutulur. Bu prototip **yalnızca kişisel kullanım** içindir. Geniş çaplı dağıtım için API çağrılarını kullanıcıya ait bir backend veya local bridge üzerinden yapmanız önerilir.

---

## Geliştirme Fikirleri

- [ ] Transkript dışa aktarma (`.srt` / `.vtt`)
- [ ] YouTube ve diğer platformlara destek
- [ ] Per-kurs çeviri önbelleği
- [ ] Side-panel UI ve oturum logları
- [ ] Local bridge ile API key güvenliği
- [ ] Seçilebilir Türkçe ses profilleri

---

## Sürüm Geçmişi

### v0.1.5
- Teknik terim koruma: çeviride İngilizce kalmasını istediğin terimler
- Strict caption mode: altyazı yokken DOM gürültüsünü filtrele
- Slot-based TTS scheduler ve pre-fetch pipeline
- Track modunda lookahead: bir sonraki cue'nun sesi önceden hazırlanır
- `computeIdealRate` ile dinamik hız adaptasyonu
- AbortController ile iptal edilebilir TTS istekleri

### v0.1.4
- Video `playbackRate` değerine göre TTS hızı
- Sync dubbing ve tts max rate ayarları
- Akıllı cümle tamamlama modu (2x+ hızlarda)

### v0.1.2
- Açık sekmelere otomatik content-script enjeksiyonu
- All-frame desteği ve `match_origin_as_fallback`
- DOM-caption modu
- Browser TTS için sistem ses seçimi
- Telaffuz sözlüğü

---

*Kişisel kullanım amaçlı prototip. Ticari dağıtım için API erişimini güvene alın.*
