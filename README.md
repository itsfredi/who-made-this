# 🔍 Who Made This?

Find the original artist of any image. **Free. Automatic. No API key.**

### How it works

**Step 1 — Platform-native scrape (97% confidence)**
If you right-click an image while already on one of these platforms, the extension reads the author directly from the page DOM — no network request needed:
- Twitter / X
- Instagram
- Reddit _(reads credits from post title)_
- Pinterest _(reads description)_
- Pixiv
- ArtStation
- DeviantArt
- Behance
- Bluesky
- Cara
- Tumblr

**Step 2 — Page metadata (72% confidence)**
On any other site, scans `og:author`, `schema.org`, JSON-LD, and nearby social media links in the page HTML.

**Step 3 — Google Lens silent tab**
Opens Google Lens in an invisible background tab, parses the results, closes the tab automatically. Uses Google's full index — works for new and obscure artists.

**Step 4 — Yandex Images fallback**
Same approach. Yandex is particularly good for digital art and non-English artists.

**Step 5 — Manual search links**
Always shown at the bottom: Google Lens, TinEye, Yandex, Bing, SauceNAO, IQDB.

---

## Install

1. Unzip this folder
2. Go to `chrome://extensions/`
3. Enable **Developer Mode** (top-right toggle)
4. Click **Load unpacked** → select the `who-made-it` folder

## Usage

Right-click any image → **"🔍 Who made this?"** — that's it.

## Confidence score guide

| Color | Range | Meaning |
|-------|-------|---------|
| 🟢 Green | 80–100% | Read directly from the platform — very reliable |
| 🟡 Yellow | 55–79% | Reverse search match — check manually |
| 🔴 Red | <55% | Weak match — use manual links to verify |

## Optional: SauceNAO key

Click the extension icon → paste a free SauceNAO key to add a 5th database layer (best for anime / fan art). Get one free at saucenao.com — no payment needed.

## Limitations

- Google Lens parsing may break if Google changes their UI (they do occasionally)
- Pinterest and Reddit rarely preserve original credits — the manual links are your best bet there
- Private/password-protected pages can't be scraped
