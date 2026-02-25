// content.js — Who Made This? v5
// GUARD: safe to inject multiple times — only initialises once per page load.
if (window.__WMT_LOADED) {
  // Already injected — just make sure we're listening
} else {
  window.__WMT_LOADED = true;
  initWMT();
}

function initWMT() {
  let panel = null;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "showPanel") {
      openPanel(msg.imageUrl, msg.pageUrl);
      sendResponse({ ok: true });
    }
    return false;
  });

  // ── Page scraper (runs in page context, has full DOM access) ────────────────
  function scrapePage() {
    const metaTags = {};
    document.querySelectorAll("meta[name],meta[property]").forEach(el => {
      const k = el.getAttribute("name") || el.getAttribute("property");
      if (k) metaTags[k] = el.getAttribute("content") || "";
    });

    const jsonLd = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const d = JSON.parse(el.textContent);
        Array.isArray(d) ? jsonLd.push(...d) : jsonLd.push(d);
      } catch {}
    });

    const nearbyLinks = Array.from(document.querySelectorAll("a[href]"))
      .map(a => a.href)
      .filter(h => /pixiv|artstation|deviantart|twitter|x\.com|instagram|tumblr|cara\.app|bsky\.app|behance|flickr|500px/.test(h))
      .slice(0, 20);

    return {
      metaTags,
      jsonLd,
      nearbyLinks,
      pageTitle: document.title,
      canonical: document.querySelector('link[rel="canonical"]')?.href || null
    };
  }

  // ── Open panel ──────────────────────────────────────────────────────────────
  function openPanel(imageUrl, pageUrl) {
    if (panel) panel.remove();
    injectStyles();

    panel = document.createElement("div");
    panel.id = "wmt-root";
    panel.innerHTML = `
      <div id="wmt-scrim"></div>
      <aside id="wmt-panel">
        <header id="wmt-header">
          <div id="wmt-logo">
            <div id="wmt-logo-mark">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            </div>
            WHO MADE THIS
          </div>
          <button id="wmt-close">✕</button>
        </header>

        <div id="wmt-strip">
          <div id="wmt-thumb-box"><img id="wmt-thumb" src="${esc(imageUrl)}" alt=""/></div>
          <div id="wmt-status">
            <div id="wmt-status-row"><span id="wmt-dot"></span><span id="wmt-status-text">Scanning…</span></div>
            <div id="wmt-status-sub">Starting analysis</div>
          </div>
        </div>

        <div id="wmt-bar"><div id="wmt-bar-fill"></div></div>

        <div id="wmt-body">
          <div id="wmt-loader">
            <div id="wmt-spinner"></div>
            <div id="wmt-loader-label">Reading page…</div>
          </div>
          <div id="wmt-results" hidden></div>
        </div>

        <footer id="wmt-footer">
          <div id="wmt-footer-title">SEARCH MANUALLY</div>
          <div id="wmt-pills"></div>
        </footer>
      </aside>`;

    document.body.appendChild(panel);
    panel.querySelector("#wmt-scrim").addEventListener("click", closePanel);
    panel.querySelector("#wmt-close").addEventListener("click", closePanel);

    // Animate in
    const aside = panel.querySelector("#wmt-panel");
    aside.style.transform = "translateX(100%)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      aside.style.transition = "transform .32s cubic-bezier(.16,1,.3,1)";
      aside.style.transform = "translateX(0)";
    }));

    runAnalysis(imageUrl, pageUrl);
  }

  function closePanel() { panel?.remove(); panel = null; }

  // ── Analysis ─────────────────────────────────────────────────────────────────
  async function runAnalysis(imageUrl, pageUrl) {
    const get = id => panel.querySelector("#" + id);
    const steps = [
      [20,  "Reading page context…"],
      [45,  "Querying SauceNAO…"],
      [72,  "Querying IQDB…"],
      [90,  "Finalising…"],
    ];
    let si = 0;
    const ticker = setInterval(() => {
      if (!panel || si >= steps.length) { clearInterval(ticker); return; }
      const [pct, lbl] = steps[si++];
      get("wmt-bar-fill").style.width = pct + "%";
      get("wmt-loader-label").textContent = lbl;
    }, 900);

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        action: "analyze",
        imageUrl,
        pageUrl,
        pageData: scrapePage()
      });
    } catch (e) {
      clearInterval(ticker);
      showError("Extension error: " + e.message);
      return;
    }

    clearInterval(ticker);
    if (!panel) return; // closed while loading

    get("wmt-bar-fill").style.width = "100%";
    await sleep(120);

    // Always show search pills
    (resp?.data?.searchLinks || []).forEach(sl => {
      const a = el("a", "wmt-pill");
      a.href = sl.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = sl.label;
      a.style.setProperty("--pc", sl.color);
      get("wmt-pills").appendChild(a);
    });

    get("wmt-loader").hidden = true;
    get("wmt-results").hidden = false;

    if (!resp?.ok) { showError(resp?.error || "Unknown error"); return; }

    const hits = resp.data?.results || [];
    if (!hits.length) {
      showEmpty(resp.data?.platform);
      setStatus("miss", "No match found", "Try the manual search links below");
      return;
    }

    const best = hits[0];
    const via = ({ platform:"Page read", context:"Metadata", saucenao:"SauceNAO", iqdb:"IQDB" })[best.method] || best.source;
    setStatus("hit", best.author || "Match found", `${hits.length} result${hits.length > 1 ? "s" : ""} · ${via}`);

    get("wmt-results").innerHTML = hits.map((r, i) => cardHTML(r, i === 0)).join("");
  }

  function setStatus(state, text, sub) {
    if (!panel) return;
    const dot  = panel.querySelector("#wmt-dot");
    const txt  = panel.querySelector("#wmt-status-text");
    const subEl= panel.querySelector("#wmt-status-sub");
    const colors = { hit:"#6ee7b7", miss:"#f59e0b", error:"#ef4444" };
    dot.style.background = colors[state] || "#64748b";
    dot.style.animation  = state === "hit" ? "none" : "wmt-pulse 1.4s infinite";
    txt.textContent = text;
    subEl.textContent = sub;
  }

  function showError(msg) {
    if (!panel) return;
    setStatus("error", "Error", "");
    panel.querySelector("#wmt-results").hidden = false;
    panel.querySelector("#wmt-results").innerHTML =
      `<div class="wmt-empty"><div class="wmt-empty-ico">⚠</div><p>${esc(msg)}</p></div>`;
  }

  function showEmpty(platform) {
    if (!panel) return;
    const tip = platform === "reddit"    ? "Reddit strips credits. Use Google Lens below."
              : platform === "pinterest" ? "Pinterest rarely preserves credits. Try TinEye."
              : "Try Google Lens or TinEye — they cover new artists not yet in databases.";
    panel.querySelector("#wmt-results").innerHTML =
      `<div class="wmt-empty"><div class="wmt-empty-ico">🔎</div><p class="wmt-empty-title">No match found</p><p class="wmt-empty-tip">${tip}</p></div>`;
  }

  // ── Card HTML ─────────────────────────────────────────────────────────────────
  function cardHTML(r, best) {
    const conf  = Math.min(100, Math.max(0, r.confidence || 0));
    const col   = conf >= 80 ? "#6ee7b7" : conf >= 55 ? "#f59e0b" : "#ef4444";
    const clbl  = conf >= 80 ? "HIGH" : conf >= 55 ? "MED" : "LOW";
    const via   = ({ platform:"⚡ PAGE", context:"📄 META", saucenao:"◈ SAUCENAO", iqdb:"◈ IQDB" })[r.method] || r.source || "";
    const main  = r.author || r.displayHandle || r.title || "Unknown";
    const hdl   = (r.displayHandle && r.author && r.displayHandle !== r.author) ? r.displayHandle : "";
    const sub   = (r.author && r.title) ? r.title.slice(0, 60) : "";
    const linkUrl   = r.authorUrl || r.socials?.[0]?.url || r.url || "#";
    const linkLabel = r.socials?.[0]?.label || "Open";
    const extras    = (r.socials || []).slice(1, 3);

    return `
      <div class="wmt-card${best ? " wmt-card--best" : ""}">
        ${best ? '<div class="wmt-ribbon">BEST MATCH</div>' : ""}
        <div class="wmt-card-row">
          <div class="wmt-card-info">
            <div class="wmt-card-name">${esc(main)}</div>
            ${hdl ? `<div class="wmt-card-handle">${esc(hdl)}</div>` : ""}
            ${sub ? `<div class="wmt-card-sub">${esc(sub)}</div>`    : ""}
            <div class="wmt-card-via">${via}</div>
          </div>
          <div class="wmt-conf" style="--cc:${col}">
            <span class="wmt-conf-n">${conf}<span class="wmt-conf-sym">%</span></span>
            <span class="wmt-conf-l">${clbl}</span>
          </div>
        </div>
        <div class="wmt-card-bar"><div style="width:${conf}%;height:100%;background:${col}"></div></div>
        <div class="wmt-card-links">
          <a class="wmt-link wmt-link--main" href="${esc(linkUrl)}" target="_blank" rel="noopener">${esc(linkLabel)}</a>
          ${extras.map(s => `<a class="wmt-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join("")}
        </div>
      </div>`;
  }

  // ── Tiny helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Styles ────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("wmt-css")) return;
    const s = document.createElement("style");
    s.id = "wmt-css";
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&display=swap');

      #wmt-root * {
        box-sizing: border-box;
        margin: 0; padding: 0;
        font-family: 'DM Mono', 'Courier New', monospace;
        -webkit-font-smoothing: antialiased;
      }

      #wmt-scrim {
        position: fixed; inset: 0; z-index: 2147483640;
        background: rgba(0,0,0,.48);
      }

      #wmt-panel {
        position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
        z-index: 2147483647;
        background: #080809;
        border-left: 1px solid #1d1d22;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: -20px 0 80px rgba(0,0,0,.8);
        color: #e8e8ec;
      }

      /* ── Header ── */
      #wmt-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 13px 16px;
        border-bottom: 1px solid #1d1d22;
        flex-shrink: 0;
      }
      #wmt-logo {
        display: flex; align-items: center; gap: 10px;
        font-size: 10px; font-weight: 500; letter-spacing: .18em;
        color: #e8e8ec;
      }
      #wmt-logo-mark {
        width: 24px; height: 24px;
        background: #6ee7b7; color: #080809;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      #wmt-close {
        background: none; border: 1px solid #1d1d22;
        color: #52526a; cursor: pointer; width: 24px; height: 24px;
        font-size: 11px; display: flex; align-items: center; justify-content: center;
        transition: all .15s;
      }
      #wmt-close:hover { border-color: #ef4444; color: #ef4444; }

      /* ── Thumb strip ── */
      #wmt-strip {
        display: flex; align-items: center; gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid #1d1d22;
        background: #0c0c0e;
        flex-shrink: 0;
      }
      #wmt-thumb-box {
        width: 50px; height: 50px; flex-shrink: 0;
        border: 1px solid #1d1d22; overflow: hidden; background: #111;
      }
      #wmt-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
      #wmt-status { flex: 1; min-width: 0; }
      #wmt-status-row {
        display: flex; align-items: center; gap: 8px;
        font-size: 12px; font-weight: 500; margin-bottom: 3px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      #wmt-dot {
        width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
        background: #6ee7b7; animation: wmt-pulse 1.4s ease-in-out infinite;
      }
      @keyframes wmt-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.25;transform:scale(.6)} }
      #wmt-status-sub { font-size: 10px; color: #52526a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      /* ── Progress bar ── */
      #wmt-bar { height: 2px; background: #1d1d22; flex-shrink: 0; }
      #wmt-bar-fill { height: 100%; width: 0%; background: #6ee7b7; transition: width .5s ease; }

      /* ── Body ── */
      #wmt-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
      #wmt-body::-webkit-scrollbar { width: 3px; }
      #wmt-body::-webkit-scrollbar-thumb { background: #1d1d22; }

      /* ── Loader ── */
      #wmt-loader { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 32px 0; }
      #wmt-spinner {
        width: 30px; height: 30px; border-radius: 50%;
        border: 2px solid #1d1d22; border-top-color: #6ee7b7;
        animation: wmt-spin .65s linear infinite;
      }
      @keyframes wmt-spin { to { transform: rotate(360deg); } }
      #wmt-loader-label { font-size: 10px; color: #52526a; letter-spacing: .1em; }

      /* ── Cards ── */
      .wmt-card {
        background: #0e0e11; border: 1px solid #1d1d22;
        margin-bottom: 8px;
      }
      .wmt-card--best { border-color: rgba(110,231,183,.4); }
      .wmt-ribbon {
        font-size: 9px; font-weight: 500; letter-spacing: .18em;
        padding: 3px 12px; color: #6ee7b7;
        background: rgba(110,231,183,.07);
        border-bottom: 1px solid rgba(110,231,183,.1);
      }
      .wmt-card-row { display: flex; align-items: center; gap: 10px; padding: 11px 12px; }
      .wmt-card-info { flex: 1; min-width: 0; }
      .wmt-card-name {
        font-size: 13px; font-weight: 500; color: #e8e8ec;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .wmt-card-handle { font-size: 10px; color: #6ee7b7; margin-top: 2px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wmt-card-sub    { font-size: 10px; color: #52526a; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wmt-card-via    { font-size: 9px;  color: #2a2a38; margin-top: 5px; letter-spacing: .08em; }

      /* Confidence box */
      .wmt-conf {
        flex-shrink: 0; width: 54px;
        border: 1px solid var(--cc);
        display: flex; flex-direction: column; align-items: center;
        padding: 6px 4px; background: #080809;
      }
      .wmt-conf-n { font-size: 18px; font-weight: 500; color: var(--cc); line-height: 1; }
      .wmt-conf-sym { font-size: 10px; }
      .wmt-conf-l { font-size: 8px; color: #52526a; margin-top: 1px; letter-spacing: .08em; }

      /* Bar under card */
      .wmt-card-bar { height: 2px; background: #1d1d22; }

      /* Link row */
      .wmt-card-links { display: flex; border-top: 1px solid #1d1d22; }
      .wmt-link {
        flex: 1; min-width: 0;
        padding: 8px 6px;
        font-size: 10px; font-weight: 500; letter-spacing: .06em;
        color: #52526a; text-decoration: none; text-align: center;
        border-right: 1px solid #1d1d22;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        transition: background .15s, color .15s;
      }
      .wmt-link:last-child { border-right: none; }
      .wmt-link:hover { background: #14141a; color: #e8e8ec; }
      .wmt-link--main { color: #6ee7b7; }
      .wmt-link--main:hover { color: #a7f3d0; }

      /* Empty */
      .wmt-empty { text-align: center; padding: 28px 12px; }
      .wmt-empty-ico { font-size: 26px; margin-bottom: 10px; }
      .wmt-empty-title { font-size: 12px; color: #e8e8ec; margin-bottom: 6px; }
      .wmt-empty-tip { font-size: 10px; color: #52526a; line-height: 1.7; }

      /* Footer */
      #wmt-footer { border-top: 1px solid #1d1d22; padding: 10px 16px; background: #080809; flex-shrink: 0; }
      #wmt-footer-title { font-size: 9px; color: #1d1d22; letter-spacing: .16em; margin-bottom: 7px; }
      #wmt-pills { display: flex; flex-wrap: wrap; gap: 4px; }
      .wmt-pill {
        padding: 5px 9px; font-size: 9px; font-weight: 500; letter-spacing: .06em;
        text-decoration: none; color: var(--pc);
        border: 1px solid color-mix(in srgb, var(--pc) 22%, transparent);
        background: color-mix(in srgb, var(--pc) 5%, transparent);
        transition: all .15s;
      }
      .wmt-pill:hover { background: color-mix(in srgb, var(--pc) 14%, transparent); border-color: var(--pc); }
    `;
    document.head.appendChild(s);
  }

} // end initWMT
