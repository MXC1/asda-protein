/*
 * ASDA Protein Filter — content script
 * --------------------------------------------------------------------------
 * On ASDA grocery search and category pages, hides every product card whose protein
 * density is below THRESHOLD g of protein per 100 kcal.
 *
 * How the data is obtained (verified against live ASDA responses):
 *   - The search grid renders one ".product-module" card per product. The
 *     Regulars tab (favourites-lists/regulars) uses a different Chakra-based
 *     grid instead, with each card a direct child of
 *     [data-testid="regular-product-grid"]. Each card contains
 *     <a href="/groceries/product/.../{CIN}"> where {CIN} is the
 *     product id.
 *   - The product page is a Mobify/Salesforce PWA. Its nutrition is server-side
 *     rendered into <script id="mobify-data"> as JSON at
 *       __PRELOADED_STATE__.pageProps.pageData.initialProduct.c_BRANDBANK_JSON
 *     which, once parsed, exposes calculatedNutrition[] (and a raw nutrition[]
 *     fallback) carrying per-100g Energy (kcal) and Protein (g).
 *
 * For each visible card we fetch its product page (same-origin), read the
 * nutrition, compute protein_per_100g / kcal_per_100g * 100 and:
 *   - >= THRESHOLD -> keep, badged with the value on a red→amber→green gradient
 *     (red at THRESHOLD, amber at GRADIENT_MID, green at GRADIENT_MAX and above)
 *   - <  THRESHOLD -> hide
 *   - no readable nutrition -> hide (counted separately as "?" in the status panel)
 *
 * Filtering only runs when the user clicks the on-page button (manual trigger).
 */
(() => {
  'use strict';
  if (window.top !== window.self) return; // ignore iframes

  const THRESHOLD = 5.4;     // grams of protein per 100 kcal required to keep
  const GRADIENT_MID = 6.5;  // ratio at which the badge is fully amber
  const GRADIENT_MAX = 7.6;  // ratio at (and above) which the badge is fully green
  const UNKNOWN_TTL = 24 * 60 * 60 * 1000; // retry unreadable items after 1 day
  const CONCURRENCY = 3;     // simultaneous product-page fetches
  const CARD = '.product-module, [data-testid="regular-product-grid"] > *';
  const LINK = 'a[href*="/groceries/product/"]';
  const STATE = 'data-apf';  // per-card marker: pending | pass | hide | unknown | skip

  let active = false;
  let observer = null;
  let scanTimer = null;
  let running = 0;
  const queue = [];
  const cache = new Map(); // cin -> result object
  const logs = [];

  /* ----------------------------------------------------------- nutrition --- */

  const toNum = (x) => {
    const s = String(x == null ? '' : x).replace(',', '.');
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  };

  const KJ_PER_KCAL = 4.184; // standard food-label conversion, used when only kJ is listed

  // calculatedNutrition: [{ nameId, nameValue, per100, perServing }]
  // 1182 = Energy (kJ), 1183 = Energy (kcal), 1184 = Protein (g)
  function fromCalculated(bb) {
    const arr = bb && bb.calculatedNutrition;
    if (!Array.isArray(arr)) return null;
    let protein = NaN, kcal = NaN, kj = NaN;
    for (const row of arr) {
      const id = row && row.nameId;
      const name = String((row && row.nameValue) || '').toLowerCase();
      if (id === '1184' || /protein/.test(name)) {
        const v = toNum(row.per100); if (Number.isFinite(v)) protein = v;
      }
      if (id === '1183' || (/energy/.test(name) && /kcal/.test(name))) {
        const v = toNum(row.per100); if (Number.isFinite(v)) kcal = v;
      }
      if (id === '1182' || (/energy/.test(name) && /\bkj\b/.test(name))) {
        const v = toNum(row.per100); if (Number.isFinite(v)) kj = v;
      }
    }
    if (!Number.isFinite(kcal) && Number.isFinite(kj)) kcal = kj / KJ_PER_KCAL;
    return (Number.isFinite(protein) && Number.isFinite(kcal)) ? { protein, kcal } : null;
  }

  // raw nutrition: [{ nutrient, headers:[...], values:[...] }]
  function fromTable(bb) {
    const arr = bb && bb.nutrition;
    if (!Array.isArray(arr)) return null;
    const per100Raw = (row) => {
      const headers = row.headers || [], values = row.values || [];
      let i = headers.findIndex((h) => /per\s*100\s*(g|ml)?\b/i.test(h) && !/%/.test(h));
      if (i < 0) i = headers.findIndex((h) => /per\s*100/i.test(h) && !/%/.test(h));
      return i < 0 ? '' : String(values[i] == null ? '' : values[i]);
    };
    // Energy rows are sometimes split ("Energy (kcal)" with a plain number),
    // sometimes combined ("Energy" with a "339 kJ / 80 kcal" value), and
    // occasionally kJ-only ("Energy" with a "1588kJ" value and no kcal figure
    // anywhere) — pull the kcal figure out of whichever form is present,
    // converting from kJ as a last resort.
    const per100Kcal = (row, raw) => {
      const mKcal = raw.match(/([\d.]+)\s*kcal/i);
      if (mKcal) return toNum(mKcal[1]);
      if (/kcal/i.test(String(row.nutrient || ''))) return toNum(raw);
      const mKj = raw.match(/([\d.]+)\s*kj/i);
      if (mKj) return toNum(mKj[1]) / KJ_PER_KCAL;
      if (/\bkj\b/i.test(String(row.nutrient || ''))) {
        const v = toNum(raw); return Number.isFinite(v) ? v / KJ_PER_KCAL : NaN;
      }
      return NaN;
    };
    let protein = NaN, kcal = NaN;
    for (const row of arr) {
      const name = String(row.nutrient || '').toLowerCase();
      const raw = per100Raw(row);
      if (/protein/.test(name)) { const v = toNum(raw); if (Number.isFinite(v)) protein = v; }
      if (/energy/.test(name)) { const v = per100Kcal(row, raw); if (Number.isFinite(v)) kcal = v; }
    }
    return (Number.isFinite(protein) && Number.isFinite(kcal)) ? { protein, kcal } : null;
  }

  // structuredNutritionEU: [{ nutrientsId, nutrientsName, nutrientAmountValue, nutrientsUnitAbbreviation }]
  // Entries appear in inconsistent per-100g / per-serving order; taking max() is safe because
  // the protein/energy ratio is scale-invariant (both numerator and denominator share the same
  // serving multiplier, which cancels), so max() always gives a consistent per-100g-equivalent.
  // nutrientsId 2452 = Energy, 2453 = Protein
  function fromStructuredEU(bb) {
    const arr = bb && bb.structuredNutritionEU;
    if (!Array.isArray(arr)) return null;
    let protein = NaN, kcal = NaN, kj = NaN;
    for (const row of arr) {
      if (!row || !row.nutrientsId) continue;
      const name = String(row.nutrientsName || '').toLowerCase();
      const unit = String(row.nutrientsUnitAbbreviation || '').toLowerCase();
      const val = parseFloat(row.nutrientAmountValue);
      if (!Number.isFinite(val) || val <= 0) continue;
      if ((row.nutrientsId === '2453' || /\bprotein\b/.test(name)) && unit === 'g') {
        if (Number.isNaN(protein) || val > protein) protein = val;
      }
      if ((row.nutrientsId === '2452' || /\benergy\b/.test(name)) && unit === 'kcal') {
        if (Number.isNaN(kcal) || val > kcal) kcal = val;
      }
      if ((row.nutrientsId === '2452' || /\benergy\b/.test(name)) && unit === 'kj') {
        if (Number.isNaN(kj) || val > kj) kj = val;
      }
    }
    if (!Number.isFinite(kcal) && Number.isFinite(kj)) kcal = kj / KJ_PER_KCAL;
    return (Number.isFinite(protein) && Number.isFinite(kcal)) ? { protein, kcal } : null;
  }

  function extractNutrition(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return null; }
    const el = doc.getElementById('mobify-data');
    if (!el) return null;
    let data; try { data = JSON.parse(el.textContent); } catch { return null; }
    const product = data
      && data.__PRELOADED_STATE__
      && data.__PRELOADED_STATE__.pageProps
      && data.__PRELOADED_STATE__.pageProps.pageData
      && data.__PRELOADED_STATE__.pageProps.pageData.initialProduct;
    if (!product || !product.c_BRANDBANK_JSON) return null;
    let bb; try { bb = JSON.parse(product.c_BRANDBANK_JSON); } catch { return null; }
    return fromCalculated(bb) || fromTable(bb) || fromStructuredEU(bb);
  }

  /* ------------------------------------------------------------- fetching --- */

  function logEntry(level, ...args) {
    const line = new Date().toISOString().slice(11, 23) + ' ' + args.join(' ');
    logs.push(line);
    (level === 'warn' ? console.warn : console.log)(...args);
  }

  function saveLogs() {
    if (!logs.length) return;
    const url = URL.createObjectURL(new Blob([logs.join('\n') + '\n'], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: 'apf-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt',
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Cache/storage lookup only — no network. Kept outside the fetch
  // concurrency pipeline so already-known results surface immediately
  // instead of waiting in the CONCURRENCY-gated queue behind items that are
  // currently being throttled.
  async function lookupLocal(cin) {
    const lbl = '[APF ' + cin + ']';
    if (cache.has(cin)) {
      const v = cache.get(cin);
      logEntry('info', lbl, '(mem)', v.status === 'ok' ? v.ratio.toFixed(1) + ' g/100kcal' : 'no readable nutrition');
      return v;
    }
    try {
      const stored = await chrome.storage.local.get('apf:' + cin);
      const v = stored['apf:' + cin];
      if (v && (v.status === 'ok' || (v.ts && Date.now() - v.ts < UNKNOWN_TTL))) {
        logEntry('info', lbl, '(stored)', v.status === 'ok' ? v.ratio.toFixed(1) + ' g/100kcal' : 'no readable nutrition');
        cache.set(cin, v);
        return v;
      }
    } catch {}
    return null;
  }

  async function nutritionFor(cin, href) {
    const lbl = '[APF ' + cin + ']';
    const local = await lookupLocal(cin);
    if (local) return local;

    const backoff = [0, 2000, 6000];
    let result = { status: 'unknown' };
    let gotRealResponse = false;

    for (let a = 0; a < backoff.length; a++) {
      if (backoff[a]) await new Promise(r => setTimeout(r, backoff[a]));
      let res;
      try {
        res = await fetch(href, { credentials: 'include' });
      } catch (e) {
        logEntry('warn', lbl, 'network error:', e.message);
        gotRealResponse = true; // network failure ≠ throttling
        break;
      }
      if (res.status === 429 || res.status === 503) {
        logEntry('warn', lbl, 'throttled (HTTP ' + res.status + '), retrying…');
        continue;
      }
      if (res.redirected) {
        logEntry('warn', lbl, 'redirected to', res.url, '— possible bot challenge, retrying…');
        continue;
      }
      if (!res.ok) { logEntry('warn', lbl, 'HTTP', res.status); gotRealResponse = true; break; }
      const html = await res.text();
      if (!/<script[^>]+id="mobify-data"/.test(html)) {
        logEntry('warn', lbl, 'no mobify-data in 200 response (bot challenge?), retrying…');
        continue;
      }
      gotRealResponse = true;
      const n = extractNutrition(html);
      if (n && n.kcal > 0 && Number.isFinite(n.protein)) {
        const ratio = (n.protein / n.kcal) * 100;
        logEntry('info', lbl, ratio.toFixed(1) + ' g/100kcal');
        result = { status: 'ok', protein: n.protein, kcal: n.kcal, ratio };
      } else {
        logEntry('info', lbl, 'no readable nutrition');
      }
      break;
    }

    if (!gotRealResponse) {
      logEntry('warn', lbl, 'all retries blocked — will re-queue in 30 s');
      return { status: 'throttled' }; // not cached; handle() will re-queue
    }
    cache.set(cin, result);
    try { await chrome.storage.local.set({ ['apf:' + cin]: { ...result, ts: Date.now() } }); } catch {}
    return result;
  }

  /* ----------------------------------------------------------------- cards --- */

  function cardInfo(card) {
    const a = card.querySelector(LINK);
    if (!a) return null;
    let url;
    try { url = new URL(a.getAttribute('href'), location.origin); } catch { return null; }
    const seg = url.pathname.split('/').filter(Boolean).pop();
    if (!/^\d+$/.test(seg || '')) return null;
    return { cin: seg, href: url.href };
  }

  // Red at THRESHOLD, amber at GRADIENT_MID, green at GRADIENT_MAX and above.
  // Two straight RGB segments (red->amber, amber->green) rather than one
  // red->green lerp, which would pass through a muddy olive at the midpoint.
  const GRADIENT_RED = [200, 16, 46];    // #c8102e
  const GRADIENT_AMBER = [180, 83, 9];   // #b45309
  const GRADIENT_GREEN = [18, 138, 62];  // #128a3e
  function colorForRatio(ratio) {
    if (!Number.isFinite(ratio)) ratio = GRADIENT_MAX;
    ratio = Math.max(THRESHOLD, Math.min(GRADIENT_MAX, ratio));
    const [lo, hi, t] = ratio <= GRADIENT_MID
      ? [GRADIENT_RED, GRADIENT_AMBER, (ratio - THRESHOLD) / (GRADIENT_MID - THRESHOLD)]
      : [GRADIENT_AMBER, GRADIENT_GREEN, (ratio - GRADIENT_MID) / (GRADIENT_MAX - GRADIENT_MID)];
    const [r, g, b] = lo.map((c, i) => Math.round(c + (hi[i] - c) * t));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function setBadge(card, kind, text, ratio) {
    let b = card.querySelector(':scope > .apf-badge');
    if (!b) {
      b = document.createElement('div');
      b.className = 'apf-badge';
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(b);
    }
    b.className = 'apf-badge apf-' + kind;
    b.style.background = kind === 'pass' ? colorForRatio(ratio) : '';
    b.textContent = text;
  }

  function clearBadge(card) {
    const b = card.querySelector(':scope > .apf-badge');
    if (b) b.remove();
  }

  function apply(card, state, ratio) {
    card.setAttribute(STATE, state);
    if (state === 'pass') {
      card.classList.remove('apf-hidden');
      setBadge(card, 'pass', ratio.toFixed(1) + ' g/100kcal', ratio);
    } else { // 'hide' or 'unknown' — both are hidden, kept distinct only for the status counts
      card.classList.add('apf-hidden');
      clearBadge(card);
    }
  }

  function restore(card) {
    card.classList.remove('apf-hidden');
    card.removeAttribute(STATE);
    if (card.style.position === 'relative') card.style.position = '';
    clearBadge(card);
  }

  /* -------------------------------------------------------------- pipeline --- */

  function scan() {
    if (!active) return;
    for (const card of document.querySelectorAll(CARD)) {
      const state = card.getAttribute(STATE);
      if (state && state !== 'skip') continue; // already processed or pending
      // 'skip' is retried on every scan: some cards (e.g. recommendation
      // carousels) mount their image before their product-name link, so a
      // card can look unfilterable on one pass and gain a valid link moments
      // later. Only cards that never get a link stay 'skip' indefinitely.
      const info = cardInfo(card);
      if (!info) { card.setAttribute(STATE, 'skip'); continue; } // not a filterable product (ad/banner)
      card.setAttribute(STATE, 'pending');
      enqueue({ card, cin: info.cin, href: info.href });
    }
    render();
  }

  // Resolves a job against the local cache/storage first, unconstrained by
  // CONCURRENCY, so cards with an already-known result get shown/hidden
  // immediately instead of sitting behind throttled fetches for other cards.
  // Only cards that actually miss the cache join the fetch-gated queue.
  function enqueue(job) {
    lookupLocal(job.cin).then((local) => {
      if (!active || !document.body.contains(job.card)) return;
      if (local) {
        if (local.status === 'ok') {
          apply(job.card, local.ratio >= THRESHOLD - 1e-9 ? 'pass' : 'hide', local.ratio);
        } else {
          apply(job.card, 'unknown', 0);
        }
        render();
        return;
      }
      queue.push(job);
      pump();
      render();
    });
  }

  function pump() {
    while (active && running < CONCURRENCY && queue.length) {
      const job = queue.shift();
      running++;
      handle(job).finally(() => { running--; render(); if (active) pump(); });
    }
  }

  async function handle(job) {
    if (!active || !document.body.contains(job.card)) return;
    const r = await nutritionFor(job.cin, job.href);
    if (!active || !document.body.contains(job.card)) return;
    if (r.status === 'throttled') {
      setTimeout(() => {
        if (active && document.body.contains(job.card)) {
          queue.push(job);
          pump();
          render();
        }
      }, 30000);
      return; // card stays 'pending' — no badge applied
    }
    if (r.status === 'ok') {
      apply(job.card, r.ratio >= THRESHOLD - 1e-9 ? 'pass' : 'hide', r.ratio);
    } else {
      apply(job.card, 'unknown', 0);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { if (active) scan(); }, 150);
  }

  /* ----------------------------------------------------------------- panel --- */

  let panel, btn, statusEl;

  function counts() {
    let shown = 0, hidden = 0, unknown = 0, pending = 0;
    for (const c of document.querySelectorAll(CARD)) {
      switch (c.getAttribute(STATE)) {
        case 'pass': shown++; break;
        case 'hide': hidden++; break;
        case 'unknown': unknown++; break;
        case 'skip': break;
        default: pending++;
      }
    }
    return { shown, hidden, unknown, pending, total: shown + hidden + unknown + pending };
  }

  function render() {
    if (!panel) return;
    const c = counts();
    const busy = running + queue.length > 0 || c.pending > 0;
    if (!active) {
      btn.textContent = 'Filter results';
      btn.classList.remove('apf-on');
      statusEl.textContent = '';
    } else {
      btn.classList.add('apf-on');
      btn.textContent = busy ? ('Filtering… ' + (c.total - c.pending) + '/' + c.total) : 'Reset (show all)';
      statusEl.textContent = 'Kept ' + c.shown + ' · Hidden ' + c.hidden + ' · ? ' + c.unknown;
    }
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'apf-panel';
    panel.innerHTML =
      '<div id="apf-title">Protein filter</div>' +
      '<button id="apf-btn" type="button"></button>' +
      '<div id="apf-status"></div>' +
      '<div id="apf-hint">Keeps items with ≥ ' + THRESHOLD + ' g protein per 100 kcal</div>' +
      '<button id="apf-save" type="button">Save logs</button>';
    document.documentElement.appendChild(panel);
    btn = panel.querySelector('#apf-btn');
    statusEl = panel.querySelector('#apf-status');
    btn.addEventListener('click', () => (active ? deactivate() : activate()));
    panel.querySelector('#apf-save').addEventListener('click', saveLogs);
    render();
  }

  /* ------------------------------------------------------------ activation --- */

  function activate() {
    active = true;
    logs.length = 0;
    logEntry('info', '=== filter run started ===');
    if (!observer) {
      observer = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.addedNodes && m.addedNodes.length) { scheduleScan(); break; }
        }
      });
    }
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  function deactivate() {
    active = false;
    if (observer) observer.disconnect();
    queue.length = 0;
    for (const c of document.querySelectorAll(CARD)) restore(c);
    render();
  }

  /* ------------------------------------------------------------ product page --- */

  let productBadgeEl = null;
  let productBadgeCin = null;

  function productInfo() {
    const seg = location.pathname.split('/').filter(Boolean).pop();
    if (!/^\d+$/.test(seg || '')) return null;
    return { cin: seg, href: location.href };
  }

  function setProductBadge(kind, text, ratio) {
    if (!productBadgeEl) {
      productBadgeEl = document.createElement('div');
      productBadgeEl.id = 'apf-product-badge';
      document.documentElement.appendChild(productBadgeEl);
    }
    productBadgeEl.className = 'apf-' + kind;
    productBadgeEl.style.background = kind === 'pass' ? colorForRatio(ratio) : '';
    productBadgeEl.textContent = text;
    productBadgeEl.style.display = '';
  }

  function hideProductBadge() {
    if (productBadgeEl) productBadgeEl.style.display = 'none';
  }

  async function loadProductBadge(info) {
    const r = await nutritionFor(info.cin, info.href);
    if (productBadgeCin !== info.cin) return; // navigated away meanwhile
    if (r.status === 'ok') {
      setProductBadge('pass', r.ratio.toFixed(1) + ' g protein / 100 kcal', r.ratio);
    } else if (r.status === 'throttled') {
      setTimeout(() => { if (productBadgeCin === info.cin) loadProductBadge(info); }, 30000);
    } else {
      setProductBadge('unknown', 'Protein data unavailable');
    }
  }

  function refreshProductBadge() {
    const info = productInfo();
    if (!info) { productBadgeCin = null; hideProductBadge(); return; }
    if (productBadgeCin === info.cin) return; // already showing/loading this product
    productBadgeCin = info.cin;
    setProductBadge('unknown', 'Protein: checking…');
    loadProductBadge(info);
  }

  /* ------------------------------------------------------------ visibility --- */

  const onSearch = () =>
    /\/groceries\//.test(location.pathname) &&
    !/\/groceries\/product\//.test(location.pathname);

  const onProduct = () => /\/groceries\/product\//.test(location.pathname);

  function syncVisibility() {
    if (!panel) return;
    if (onSearch()) {
      panel.style.display = '';
    } else {
      panel.style.display = 'none';
      if (active) deactivate();
    }
    if (onProduct()) {
      refreshProductBadge();
    } else {
      productBadgeCin = null;
      hideProductBadge();
    }
  }

  /* ------------------------------------------------------------------ init --- */

  function init() {
    if (document.getElementById('apf-panel')) return;
    buildPanel();
    syncVisibility();
    // The site is a single-page app; watch for client-side navigations so the
    // panel only shows on search pages.
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) { last = location.href; syncVisibility(); }
    }, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
