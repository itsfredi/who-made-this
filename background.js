// background.js — Who Made This? v7
//
// THE BUG THAT WAS KILLING EVERYTHING:
// runInTab removed its onUpdated listener on the FIRST "complete" event.
// But Google Lens fires "complete" on the uploadbyurl *redirect stub* before
// the actual search results page loads. We were injecting into an empty page.
// Fix: debounce. Track ALL status changes. Only inject after the tab has been
// "complete" with no new "loading" event for 2 seconds.

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "whoMadeThis",
    title: "🔍 Who made this?",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "whoMadeThis" || !tab?.id || !info.srcUrl) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ["content.js"]
    });
  } catch (e) { console.warn("Inject failed:", e.message); return; }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: "showPanel",
      imageUrl: info.srcUrl,
      pageUrl: tab.url
    });
  } catch (e) { console.warn("showPanel failed:", e.message); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "analyze") {
    handleAnalyze(msg)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.action === "getSettings") {
    chrome.storage.sync.get(["sauceNaoKey"], r => sendResponse({ sauceNaoKey: r?.sauceNaoKey || "" }));
    return true;
  }
  if (msg.action === "saveSettings") {
    chrome.storage.sync.set({ sauceNaoKey: msg.sauceNaoKey || "" }, () => sendResponse({ ok: true }));
    return true;
  }
});

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function handleAnalyze({ imageUrl, pageUrl, pageData }) {
  const results  = [];
  const platform = detectPlatform(pageUrl);
  const isData   = imageUrl?.startsWith("data:");

  // Step 1 — Platform DOM scrape (instant, highest confidence)
  if (pageData && platform) {
    const r = platformScrape(pageData, platform, pageUrl);
    if (r) results.push({ ...r, confidence: 97, method: "platform" });
  }
  if (!results.length && pageData) {
    const r = contextScrape(pageData, pageUrl);
    if (r) results.push({ ...r, confidence: 72, method: "context" });
  }

  if (isData) {
    results.sort((a, b) => b.confidence - a.confidence);
    return { platform, results: dedupe(results).slice(0, 8), searchLinks: buildSearchLinks(imageUrl) };
  }

  // Step 2 — Google Lens (widest coverage: paintings, photos, new artists, everything)
  if (results.length === 0 || results[0].confidence < 85) {
    const r = await runInTab(
      `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`,
      lensParser,
      { settleSec: 2.5, totalSec: 25 }
    );
    results.push(...r);
    console.log(`Lens returned ${r.length} results`);
  }

  // Step 3 — Yandex (strong for art, paintings, European/Asian artists)
  if (results.length === 0 || results[0].confidence < 70) {
    const r = await runInTab(
      `https://yandex.com/images/search?url=${encodeURIComponent(imageUrl)}&rpt=imageview`,
      yandexParser,
      { settleSec: 2, totalSec: 20 }
    );
    results.push(...r);
    console.log(`Yandex returned ${r.length} results`);
  }

  // Step 4 — SauceNAO (best for anime/illustration/Pixiv)
  if (results.length === 0 || results[0].confidence < 60) {
    try {
      const r = await fetchSauceNao(imageUrl);
      results.push(...r);
    } catch (e) { console.warn("SauceNAO:", e.message); }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return { platform, results: dedupe(results).slice(0, 8), searchLinks: buildSearchLinks(imageUrl) };
}

// ── Silent tab runner (with redirect-aware debounce) ──────────────────────────
function runInTab(url, parserFn, { settleSec = 2.5, totalSec = 25 } = {}) {
  return new Promise(resolve => {
    let tabId     = null;
    let settleTimer = null;
    let injected  = false;
    let done      = false;

    const finish = (results = []) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(settleTimer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
      resolve(results);
    };

    // Hard ceiling — always resolve, never leave pipeline hanging
    const hardTimer = setTimeout(() => {
      console.warn("runInTab hard timeout for", url);
      finish([]);
    }, totalSec * 1000);

    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === "loading") {
        // Redirect happening — cancel any pending inject
        clearTimeout(settleTimer);
      }
      if (info.status === "complete") {
        // Start settle timer — inject only if no new loading arrives
        clearTimeout(settleTimer);
        settleTimer = setTimeout(doInject, settleSec * 1000);
      }
    }

    function doInject() {
      if (injected || done) return;
      injected = true;
      chrome.scripting.executeScript({
        target: { tabId },
        func: parserFn,
        args: [8000]   // 8s for async DOM polling inside the parser
      }).then(res => {
        finish(res?.[0]?.result || []);
      }).catch(err => {
        console.warn("executeScript failed:", err.message);
        finish([]);
      });
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.create({ url, active: false }, tab => {
      if (chrome.runtime.lastError) {
        console.warn("tabs.create failed:", chrome.runtime.lastError.message);
        finish([]);
        return;
      }
      tabId = tab.id;
    });
  });
}

// ── Google Lens parser — runs INSIDE the Lens tab ────────────────────────────
// Self-contained. Returns a promise (MV3 awaits it).
// Polls with MutationObserver until off-Google links appear, then scrapes.
async function lensParser(pollMs) {
  await new Promise(resolve => {
    const deadline = setTimeout(resolve, pollMs);
    // MutationObserver is faster than polling — fires the moment DOM changes
    const obs = new MutationObserver(() => {
      const offsite = document.querySelectorAll("a[href]");
      let count = 0;
      for (const a of offsite) {
        try {
          if (!new URL(a.href).hostname.includes("google")) count++;
        } catch {}
      }
      if (count >= 4) {
        clearTimeout(deadline);
        obs.disconnect();
        resolve();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
  // Extra buffer for lazy-loaded tiles
  await new Promise(r => setTimeout(r, 1500));

  // ── Helpers (must be inline — no outer scope access) ──────────────────────
  function host(url) {
    try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; }
  }
  function label(h) {
    return ({
      "x.com":"Twitter/X","twitter.com":"Twitter/X","instagram.com":"Instagram",
      "pixiv.net":"Pixiv","artstation.com":"ArtStation","deviantart.com":"DeviantArt",
      "pinterest.com":"Pinterest","reddit.com":"Reddit","tumblr.com":"Tumblr",
      "behance.net":"Behance","flickr.com":"Flickr","500px.com":"500px",
      "wikipedia.org":"Wikipedia","britannica.com":"Britannica","wikiart.org":"WikiArt",
      "metmuseum.org":"The Met","louvre.fr":"Louvre","uffizi.it":"Uffizi",
      "nationalgallery.org.uk":"National Gallery","rijksmuseum.nl":"Rijksmuseum",
      "moma.org":"MoMA","tate.org.uk":"Tate","nga.gov":"NGA",
    })[h] || h;
  }

  // Extract artist/author from a title string + the destination URL
  function extractAuthor(title, href) {
    let author = null, authorUrl = href, displayHandle = null;
    try {
      const u = new URL(href);
      const h = u.hostname.replace("www.", "");
      const paths = u.pathname.split("/").filter(Boolean);

      if (h === "x.com" || h === "twitter.com") {
        const handle = paths[0];
        if (handle && !["i","search","home","explore","hashtag"].includes(handle)) {
          const m = title.match(/^Post by (.+?) on (?:X|Twitter)/i)
                 || title.match(/^(.+?)\s+on (?:X|Twitter)/i);
          author = m?.[1]?.trim() || `@${handle}`;
          displayHandle = `@${handle}`;
          authorUrl = `https://x.com/${handle}`;
        }
      } else if (h === "instagram.com") {
        const slug = paths[0];
        if (slug && !["p","reel","stories","explore","accounts"].includes(slug)) {
          displayHandle = `@${slug}`;
          authorUrl = `https://instagram.com/${slug}`;
          author = title.match(/^([^•(@|\n]{2,40})/)?.[1]?.trim() || displayHandle;
        }
      } else if (h === "pixiv.net") {
        const uid = u.pathname.match(/users\/(\d+)/);
        if (uid) authorUrl = `https://www.pixiv.net/en/users/${uid[1]}`;
        author = title.match(/^(.+?)\s*[-–|·]/)?.[1]?.trim() || null;
      } else if (h === "artstation.com") {
        const slug = paths[0];
        if (slug && slug !== "artwork") {
          authorUrl = `https://www.artstation.com/${slug}`;
          author = title.match(/^(.+?)\s*[-–|·]/)?.[1]?.trim() || slug;
          displayHandle = slug;
        }
      } else if (h === "deviantart.com") {
        const slug = paths[0];
        if (slug && slug !== "tag") {
          author = slug; displayHandle = slug;
          authorUrl = `https://deviantart.com/${slug}`;
        }
      } else if (h === "wikipedia.org" || h === "britannica.com" || h === "wikiart.org") {
        // "Caravaggio - Wikipedia" → "Caravaggio"
        // "The Starry Night - Wikipedia" → artwork, not author — skip short ones
        const subj = title.split(/\s[-–—|]\s/)[0]?.trim();
        if (subj && subj.length > 1 && subj.length < 60 && !subj.match(/^(list|category|talk|file|help)/i)) {
          author = subj;
        }
      }

      // Generic "by Name" pattern
      if (!author) {
        const m = title.match(/\bby\s+([A-Z][a-zA-ZÀ-ÖØ-öø-ÿ\s\-'.]{1,35})(?:\s*[,|–—·]|\s*$)/);
        if (m) author = m[1].trim();
      }
    } catch {}
    return { author, authorUrl, displayHandle };
  }

  // Scan all off-google anchors
  const seen = new Set();
  const raw  = [];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (!href || seen.has(href)) continue;
    try {
      const u = new URL(href);
      if (u.hostname.includes("google") || u.hostname.includes("gstatic") || u.hostname.length < 5) continue;
    } catch { continue; }
    seen.add(href);

    // Collect best title: h3 in subtree > parent h3 > aria-label > text
    const h3 = a.querySelector("h3") || a.closest("[data-action-url],[jsaction],[data-ved]")?.querySelector("h3");
    const raw_title = h3?.textContent?.trim()
                   || a.getAttribute("aria-label")
                   || a.title
                   || (a.textContent.trim().length < 200 ? a.textContent.trim() : "");
    const title = raw_title.trim();
    if (!title && !href) continue;

    const h = host(href);
    const { author, authorUrl, displayHandle } = extractAuthor(title, href);
    const lbl = label(h);

    const knownArtist = ["x.com","twitter.com","instagram.com","pixiv.net","artstation.com","deviantart.com","behance.net","flickr.com"].includes(h);
    const encyclopedic = ["wikipedia.org","britannica.com","wikiart.org","metmuseum.org","louvre.fr","moma.org","tate.org.uk","uffizi.it","nationalgallery.org.uk","rijksmuseum.nl","nga.gov"].includes(h);
    const conf = author
      ? (knownArtist ? 82 : encyclopedic ? 78 : 65)
      : (encyclopedic ? 60 : 50);

    raw.push({ author, displayHandle, title: author ? null : (title.slice(0, 80) || null), url: href, authorUrl, confidence: conf, socials: [{ label: lbl, url: authorUrl || href, handle: displayHandle }], source: "Google Lens", method: "lens" });
  }

  // Sort: authored results first, then encyclopedic, then by confidence
  raw.sort((a, b) => {
    if (a.author && !b.author) return -1;
    if (!a.author && b.author) return 1;
    return b.confidence - a.confidence;
  });

  // Dedupe by authorUrl
  const out = [], seenUrls = new Set();
  for (const r of raw) {
    const k = r.authorUrl || r.url;
    if (!seenUrls.has(k)) { seenUrls.add(k); out.push(r); }
  }
  return out.slice(0, 6);
}

// ── Yandex parser — runs INSIDE the Yandex tab ───────────────────────────────
async function yandexParser(pollMs) {
  await new Promise(resolve => {
    const deadline = setTimeout(resolve, pollMs);
    const obs = new MutationObserver(() => {
      if (document.querySelector(".CbirSites-Item, .cbir-section, [class*='cbir'], .CbirObject")) {
        clearTimeout(deadline); obs.disconnect(); resolve();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
  await new Promise(r => setTimeout(r, 800));

  function host(url) { try { return new URL(url).hostname.replace("www.",""); } catch { return ""; } }
  function lbl(h) {
    return ({"x.com":"Twitter/X","twitter.com":"Twitter/X","instagram.com":"Instagram","pixiv.net":"Pixiv","artstation.com":"ArtStation","deviantart.com":"DeviantArt","wikipedia.org":"Wikipedia","wikiart.org":"WikiArt","britannica.com":"Britannica"})[h] || h;
  }

  const results = [];

  // Entity / subject detected by Yandex vision
  const entity = document.querySelector(".CbirObject-Title, [class*='CbirObject'] [class*='Title'], .CbirObjectResponse-Title");
  if (entity?.textContent?.trim()) {
    results.push({ author: entity.textContent.trim(), title: null, url: null, authorUrl: null, confidence: 70, socials: [], source: "Yandex Vision", method: "yandex" });
  }

  // "Sites with this image" blocks
  document.querySelectorAll(".CbirSites-Item, [class*='SiteItem'], .cbir-section__sites .site").forEach(item => {
    const a    = item.querySelector("a[href]");
    const href = a?.href || "";
    if (!href.startsWith("http")) return;
    const titleEl = item.querySelector("[class*='Title'],[class*='title'],h3");
    const title   = titleEl?.textContent?.trim() || a?.textContent?.trim() || "";
    const h       = host(href);
    const byM     = title.match(/\bby\s+([A-Z][a-zA-ZÀ-ÖØ-öø-ÿ\s\-'.]{1,35})(?:[,.|–—]|$)/);
    const author  = byM?.[1]?.trim() || null;
    // Wikipedia-style: "Caravaggio - Wikipedia" → "Caravaggio"
    let authFromTitle = null;
    if (["wikipedia.org","wikiart.org","britannica.com"].includes(h)) {
      const subj = title.split(/\s[-–—|]\s/)[0]?.trim();
      if (subj && subj.length < 60) authFromTitle = subj;
    }
    results.push({ author: author || authFromTitle, title: (author || authFromTitle) ? null : title.slice(0,80), url: href, authorUrl: href, confidence: (author || authFromTitle) ? 68 : 52, socials: [{ label: lbl(h), url: href }], source: "Yandex Images", method: "yandex" });
  });

  results.sort((a, b) => b.confidence - a.confidence);
  const out = [], seen = new Set();
  for (const r of results) {
    const k = (r.author || r.title || "").toLowerCase().slice(0, 60);
    if (k && !seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out.slice(0, 5);
}

// ── SauceNAO ──────────────────────────────────────────────────────────────────
async function fetchSauceNao(imageUrl) {
  const stored = await chrome.storage.sync.get(["sauceNaoKey"]).catch(() => ({}));
  const key    = stored?.sauceNaoKey || "";
  const params = new URLSearchParams({ output_type: "2", numres: "8", url: imageUrl });
  if (key) params.set("api_key", key);
  const res  = await fetch(`https://saucenao.com/search.php?${params}`);
  if (!res.ok) throw new Error(`SauceNAO ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.results)) return [];
  return json.results
    .filter(r => parseFloat(r.header?.similarity || 0) >= 50)
    .map(r => {
      const sim  = parseFloat(r.header?.similarity || 0);
      const d    = r.data || {};
      const idx  = (r.header?.index_name || "").replace(/^Index #\d+: /, "");
      const author = d.member_name || d.creator || d.author_name || d.author || d.twitter_user_handle || null;
      const socials = [];
      (d.ext_urls || []).forEach(u => { try { socials.push({ label: new URL(u).hostname.replace("www.",""), url: u }); } catch {} });
      if (d.member_id && /pixiv/i.test(idx)) socials.push({ label:"Pixiv", url:`https://www.pixiv.net/en/users/${d.member_id}` });
      if (d.twitter_user_handle) socials.push({ label:"Twitter/X", url:`https://x.com/${d.twitter_user_handle}`, handle:`@${d.twitter_user_handle}` });
      return { author, displayHandle: d.twitter_user_handle ? `@${d.twitter_user_handle}` : null, title: d.title || d.eng_name || null, url: (d.ext_urls||[])[0]||null, authorUrl: (d.ext_urls||[])[0]||null, confidence: Math.round(sim), socials: dedupeSocials(socials), source:"SauceNAO", indexName:idx, method:"saucenao" };
    });
}

// ── Platform DOM scrape ───────────────────────────────────────────────────────
function platformScrape(data, platform, pageUrl) {
  const { metaTags = {}, jsonLd = [], pageTitle = "", canonical } = data;
  const url  = canonical || pageUrl;
  const meta = (...keys) => keys.reduce((v, k) => v || metaTags[k] || metaTags[`og:${k}`] || metaTags[`twitter:${k}`] || null, null);
  switch (platform) {
    case "twitter": {
      const title = meta("title") || pageTitle;
      const nm = title.match(/^(.+?)\s+on\s+(?:X|Twitter)/i);
      const hm = url.match(/(?:twitter|x)\.com\/([^/?#]+)\/status/);
      if (!nm?.[1] && !hm?.[1]) return null;
      return { author: nm?.[1] || `@${hm?.[1]}`, displayHandle: hm?.[1] ? `@${hm[1]}` : null, socials: hm?.[1] ? [{ label:"Twitter/X", url:`https://x.com/${hm[1]}`, handle:`@${hm[1]}` }] : [], source:"Twitter/X", url };
    }
    case "instagram": {
      const title = meta("title") || pageTitle;
      const hm = title.match(/@([\w.]+)/), nm = title.match(/^([^•(@\n]+)/);
      if (!hm?.[1] && !nm?.[1]) return null;
      return { author: nm?.[1]?.trim() || `@${hm?.[1]}`, displayHandle: hm?.[1] ? `@${hm[1]}` : null, socials: hm?.[1] ? [{ label:"Instagram", url:`https://instagram.com/${hm[1]}` }] : [], source:"Instagram", url };
    }
    case "pixiv": {
      const ld = jsonLd.find(j => j.author); const author = ld?.author?.name || meta("author"); const uid = url.match(/pixiv\.net\/(?:en\/)?users\/(\d+)/)?.[1];
      return author ? { author, socials: uid ? [{ label:"Pixiv", url:`https://www.pixiv.net/en/users/${uid}` }] : [], source:"Pixiv", url } : null;
    }
    case "artstation": {
      const ld = jsonLd.find(j => j.author); const author = ld?.author?.name || meta("author"); const h = url.match(/artstation\.com\/([^/?#]+)/)?.[1];
      return author ? { author, socials: h ? [{ label:"ArtStation", url:`https://www.artstation.com/${h}` }] : [], source:"ArtStation", url } : null;
    }
    case "deviantart": {
      const ld = jsonLd.find(j => j.author); const author = ld?.author?.name || meta("author"); const h = url.match(/deviantart\.com\/([^/?#]+)/)?.[1];
      return author ? { author, socials: h ? [{ label:"DeviantArt", url:`https://www.deviantart.com/${h}` }] : [], source:"DeviantArt", url } : null;
    }
    case "behance": { const h = url.match(/behance\.net\/([^/?#]+)/)?.[1]; const author = meta("author") || h; return author ? { author, socials: h ? [{ label:"Behance", url:`https://behance.net/${h}` }] : [], source:"Behance", url } : null; }
    case "bluesky": { const h = url.match(/bsky\.app\/profile\/([^/?#]+)/)?.[1]; const author = (meta("title")||pageTitle).match(/^([^|:–—\n]+)/)?.[1]?.trim()||h; return author ? { author, socials: h ? [{ label:"Bluesky", url:`https://bsky.app/profile/${h}` }] : [], source:"Bluesky", url } : null; }
    case "cara": { const h = url.match(/cara\.app\/([^/?#]+)/)?.[1]; const author = meta("author")||h; return author ? { author, socials: h ? [{ label:"Cara", url:`https://cara.app/${h}` }] : [], source:"Cara", url } : null; }
    case "tumblr": { const h = url.match(/([^.]+)\.tumblr\.com/)?.[1]; const author = meta("author")||h; return author ? { author, socials: h ? [{ label:"Tumblr", url:`https://${h}.tumblr.com` }] : [], source:"Tumblr", url } : null; }
    case "reddit": { const title = meta("title")||pageTitle; const m = title.match(/(?:by|art by|artist:|drawn by|OC by|photo by)\s*u?\/?([\w-]+)/i); return m?.[1] ? { author:`u/${m[1]}`, confidence:80, socials:[{ label:"Reddit", url:`https://reddit.com/user/${m[1]}` }], source:"Reddit title", url } : null; }
    case "pinterest": { const desc = meta("description")||""; const m = desc.match(/(?:by|from|via|artist)\s+([A-Za-z0-9_\-.@ ]{2,40})/i); return m?.[1] ? { author:m[1].trim(), confidence:55, socials:[], source:"Pinterest", url } : null; }
    default: return null;
  }
}

function contextScrape(data, pageUrl) {
  const { metaTags = {}, jsonLd = [], nearbyLinks = [] } = data;
  const meta = k => metaTags[k] || metaTags[`og:${k}`] || metaTags[`article:${k}`] || null;
  const ld   = jsonLd.find(j => j.author?.name || typeof j.author === "string");
  const author = ld?.author?.name || (typeof ld?.author === "string" ? ld.author : null) || meta("author") || metaTags["author"] || null;
  if (!author) return null;
  const artistHosts = ["twitter.com","x.com","instagram.com","artstation.com","deviantart.com","pixiv.net","behance.net","tumblr.com","cara.app","bsky.app"];
  const socials = [];
  try { const u = ld?.author?.url; if (u) socials.push({ label: new URL(u).hostname.replace("www.",""), url: u }); } catch {}
  for (const href of nearbyLinks) { try { const h = new URL(href).hostname.replace("www.",""); if (artistHosts.some(d => h.includes(d))) socials.push({ label: h, url: href }); } catch {} }
  return { author, socials: dedupeSocials(socials), source:"Page metadata", url: pageUrl };
}

function detectPlatform(url = "") {
  const c = [[/twitter\.com|x\.com/,"twitter"],[/instagram\.com/,"instagram"],[/pixiv\.net/,"pixiv"],[/artstation\.com/,"artstation"],[/deviantart\.com/,"deviantart"],[/behance\.net/,"behance"],[/bsky\.app/,"bluesky"],[/cara\.app/,"cara"],[/tumblr\.com/,"tumblr"],[/reddit\.com/,"reddit"],[/pinterest\./,"pinterest"]];
  for (const [re,n] of c) if (re.test(url)) return n;
  return null;
}
function dedupe(arr) { const s = new Set(); return arr.filter(r => { const k = (r.author||r.title||r.url||"").toLowerCase().slice(0,80); if (!k||s.has(k)) return false; s.add(k); return true; }); }
function dedupeSocials(arr) { const s = new Set(); return arr.filter(r => { if (!r?.url||s.has(r.url)) return false; s.add(r.url); return true; }); }
function buildSearchLinks(imageUrl) {
  const e = encodeURIComponent(imageUrl||"");
  return [
    { label:"Google Lens", url:`https://lens.google.com/uploadbyurl?url=${e}`, color:"#4285f4" },
    { label:"TinEye",      url:`https://tineye.com/search?url=${e}`,            color:"#a855f7" },
    { label:"Yandex",      url:`https://yandex.com/images/search?url=${e}&rpt=imageview`, color:"#ef4444" },
    { label:"SauceNAO",    url:`https://saucenao.com/search.php?url=${e}`,      color:"#f59e0b" },
    { label:"IQDB",        url:`https://iqdb.org/?url=${e}`,                    color:"#22c55e" },
  ];
}
