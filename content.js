/*
 * ASDA Protein Filter — content script
 * --------------------------------------------------------------------------
 * On ASDA grocery search and category pages, hides every product card whose protein
 * density falls outside a chosen range of g of protein per 100 kcal (default:
 * below THRESHOLD).
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
 *   - inside the panel's range slider -> keep, badged with the value on a
 *     red→amber→green gradient (red at THRESHOLD, amber at GRADIENT_MID, green
 *     at GRADIENT_MAX and above)
 *   - outside it -> hide
 *   - no readable nutrition -> hide (counted separately as "?" in the status panel)
 * The slider defaults to THRESHOLD..∞ (rangeMin/rangeMax) and re-filters
 * already-fetched cards live from the in-memory cache as it moves.
 *
 * Filtering only runs when the user clicks the on-page button (manual trigger).
 *
 * On the trolley page (/groceries/trolley), a separate panel computes the
 * protein density of the trolley as a whole meal instead of filtering: total
 * protein across every line item (scaled by that product's pack weight and
 * quantity) divided by total kcal, i.e. "if I ate this whole trolley, what's
 * the protein per 100 kcal?". Pack weight is recovered per item from whichever
 * of three signals is available (unit price, size label, or per-serving
 * nutrition x unit count — see extractNutrition), falling back to an assumed
 * 100g only when none of them apply.
 * Each line item is rendered three times (once per responsive breakpoint,
 * only one visible at a time), so rows are found by climbing from each
 * product link to its nearest ancestor holding a quantity stepper
 * ([data-testid="update-plus-btn"]) and keeping only the one with a non-null
 * offsetParent.
 */
(() => {
  'use strict';
  if (window.top !== window.self) return; // ignore iframes

  const THRESHOLD = 5.4;     // default lower bound (g protein per 100 kcal); also the red end of the badge gradient
  const SLIDER_MAX = 20;     // top of the slider's scale — the top stop means "no upper limit" (∞)
  const SLIDER_STEP = 0.1;
  const GRADIENT_MID = 6.5;  // ratio at which the badge is fully amber
  const GRADIENT_MAX = 7.6;  // ratio at (and above) which the badge is fully green
  const UNKNOWN_TTL = 24 * 60 * 60 * 1000; // retry unreadable items after 1 day
  const CONCURRENCY = 3;     // simultaneous product-page fetches
  const CARD = '.product-module, [data-testid="regular-product-grid"] > *';
  const LINK = 'a[href*="/groceries/product/"]';
  const STATE = 'data-apf';  // per-card marker: pending | pass | hide | unknown | skip

  let active = false;
  let rangeMin = THRESHOLD;  // current slider range; ratios outside it are hidden
  let rangeMax = Infinity;
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
    let protein = NaN, kcal = NaN, kj = NaN, kcalServing = NaN, kjServing = NaN;
    for (const row of arr) {
      const id = row && row.nameId;
      const name = String((row && row.nameValue) || '').toLowerCase();
      if (id === '1184' || /protein/.test(name)) {
        const v = toNum(row.per100); if (Number.isFinite(v)) protein = v;
      }
      if (id === '1183' || (/energy/.test(name) && /kcal/.test(name))) {
        const v = toNum(row.per100); if (Number.isFinite(v)) kcal = v;
        const vs = toNum(row.perServing); if (Number.isFinite(vs)) kcalServing = vs;
      }
      if (id === '1182' || (/energy/.test(name) && /\bkj\b/.test(name))) {
        const v = toNum(row.per100); if (Number.isFinite(v)) kj = v;
        const vs = toNum(row.perServing); if (Number.isFinite(vs)) kjServing = vs;
      }
    }
    if (!Number.isFinite(kcal) && Number.isFinite(kj)) kcal = kj / KJ_PER_KCAL;
    if (!Number.isFinite(kcalServing) && Number.isFinite(kjServing)) kcalServing = kjServing / KJ_PER_KCAL;
    return (Number.isFinite(protein) && Number.isFinite(kcal)) ? { protein, kcal, kcalServing } : null;
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

  // Three ways to recover a pack's total weight in grams, tried in order of
  // reliability (verified against live ASDA product pages):
  //
  // 1. ASDA's own per-kg/per-litre unit price ("£7.63/kg" + price £2.44 -> 320g).
  //    Clean structured numbers, so it's preferred whenever the item is actually
  //    priced by weight/volume (c_price_comp_uom_cd KG or LT).
  // 2. The c_SIZE label itself ("320G", "8X115G", "330ml", "1.13KG"). Needed when
  //    an item is priced "each" but its label still states a real weight.
  // 3. Per-serving kcal vs per-100g kcal backs out one serving's weight, multiplied
  //    by "Number of Units" (servings per pack). Last resort for each-priced
  //    multipacks with no weight anywhere else (e.g. "6 iced buns", 27.3p/ea,
  //    c_SIZE "6PK") that still carry real nutrition — confirmed against a live
  //    example where this recovers ~241g (40g/bun x 6) with no other signal available.
  //
  // Genuine count-only items with no weight-bearing price, label, or serving data
  // (e.g. eggs) return null from all three; in practice those also tend to lack a
  // nutrition panel entirely, so they're already excluded upstream as unreadable.

  // Treats ml as 1:1 with g — fine for the water-based drinks/liquids this matters for.
  function parsePackGramsFromLabel(size) {
    const m = String(size || '').trim().match(/^(?:(\d+(?:\.\d+)?)\s*x\s*)?(\d+(?:\.\d+)?)\s*(kg|g|l|ml)$/i);
    if (!m) return null;
    const count = m[1] ? parseFloat(m[1]) : 1;
    const each = parseFloat(m[2]);
    const unit = m[3].toLowerCase();
    const perUnitGrams = (unit === 'kg' || unit === 'l') ? each * 1000 : each;
    return count * perUnitGrams;
  }

  function parsePackGramsFromPrice(product) {
    const uom = String(product.c_price_comp_uom_cd || '').toUpperCase();
    if (uom !== 'KG' && uom !== 'LT') return null; // "EA" etc. isn't a weight/volume basis
    const compQty = parseFloat(product.c_price_comp_qty);
    const price = parseFloat(product.price);
    const m = String(product.c_pricePerUOM || '').match(/£\s*([\d.]+)|([\d.]+)\s*p\b/i);
    if (!m || !Number.isFinite(compQty) || compQty <= 0 || !Number.isFinite(price)) return null;
    const perUnitPrice = m[1] != null ? parseFloat(m[1]) : parseFloat(m[2]) / 100;
    if (!Number.isFinite(perUnitPrice) || perUnitPrice <= 0) return null;
    return (price / perUnitPrice) * compQty * 1000;
  }

  function parsePackGramsFromServing(n, bb) {
    if (!Number.isFinite(n.kcalServing) || !(n.kcal > 0)) return null;
    const units = bb && Array.isArray(bb.numberOfUnits) && bb.numberOfUnits[0];
    const count = units && parseInt(units.text, 10);
    if (!Number.isFinite(count) || count <= 0) return null;
    const servingGrams = (n.kcalServing / n.kcal) * 100;
    return servingGrams * count;
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
    const n = fromCalculated(bb) || fromTable(bb) || fromStructuredEU(bb);
    if (!n) return null;
    const grams = parsePackGramsFromPrice(product)
      ?? parsePackGramsFromLabel(product.c_SIZE)
      ?? parsePackGramsFromServing(n, bb);
    return { ...n, grams };
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
      // 'ok' entries cached before pack weight (grams) was tracked lack that field;
      // treat them as a miss so they refetch and pick it up, instead of silently
      // falling back to an assumed weight in the trolley total forever.
      const stale = v && v.status === 'ok' && !('grams' in v);
      if (v && !stale && (v.status === 'ok' || (v.ts && Date.now() - v.ts < UNKNOWN_TTL))) {
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
        result = { status: 'ok', protein: n.protein, kcal: n.kcal, ratio, grams: n.grams };
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

  function stateFor(ratio) {
    return ratio >= rangeMin - 1e-9 && ratio <= rangeMax + 1e-9 ? 'pass' : 'hide';
  }

  // Re-judges every already-resolved card against the current range straight
  // from the in-memory cache (no network). Unreadable cards stay hidden, and
  // pending ones pick the range up whenever their result arrives.
  function reapplyRange() {
    if (!active) return;
    for (const card of document.querySelectorAll(CARD)) {
      const state = card.getAttribute(STATE);
      if (state !== 'pass' && state !== 'hide') continue;
      const info = cardInfo(card);
      const r = info && cache.get(info.cin);
      if (r && r.status === 'ok') apply(card, stateFor(r.ratio), r.ratio);
    }
    render();
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
          apply(job.card, stateFor(local.ratio), local.ratio);
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
      apply(job.card, stateFor(r.ratio), r.ratio);
    } else {
      apply(job.card, 'unknown', 0);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { if (active) scan(); }, 150);
  }

  /* ----------------------------------------------------------------- panel --- */

  let panel, btn, statusEl, sliderEl, thumbA, thumbB, rangeLabelEl, sliderResetBtn;

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

  // The slider is two overlaid native range inputs sharing one track. Neither
  // is "the" lower or upper handle: the range is whichever is smaller/larger,
  // so the handles can cross or sit on top of each other without either one
  // ever becoming unreachable. Parking a handle on SLIDER_MAX means ∞.
  function syncRange() {
    const a = Number(thumbA.value), b = Number(thumbB.value);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    rangeMin = lo;
    rangeMax = hi >= SLIDER_MAX ? Infinity : hi;
    sliderEl.style.setProperty('--lo', lo / SLIDER_MAX);
    sliderEl.style.setProperty('--hi', hi / SLIDER_MAX);
    rangeLabelEl.textContent = rangeMin + ' – ' + (rangeMax === Infinity ? '∞' : rangeMax) + ' g/100 kcal';
    sliderResetBtn.disabled = rangeMin === THRESHOLD && rangeMax === Infinity;
    reapplyRange();
  }

  function buildPanel() {
    const thumb = '" type="range" min="0" max="' + SLIDER_MAX + '" step="' + SLIDER_STEP +
      '" aria-label="Protein per 100 kcal range handle">';
    panel = document.createElement('div');
    panel.id = 'apf-panel';
    panel.innerHTML =
      '<div id="apf-title">Protein filter</div>' +
      '<button id="apf-btn" type="button"></button>' +
      '<div id="apf-status"></div>' +
      '<div id="apf-range-label"></div>' +
      '<div id="apf-slider">' +
        '<div id="apf-slider-track"></div>' +
        '<div id="apf-slider-fill"></div>' +
        '<input id="apf-thumb-a' + thumb +
        '<input id="apf-thumb-b' + thumb +
      '</div>' +
      '<div id="apf-slider-ends"><span>0</span><span>∞</span></div>' +
      '<button id="apf-slider-reset" type="button">Reset slider</button>' +
      '<button id="apf-save" type="button">Save logs</button>';
    document.documentElement.appendChild(panel);
    btn = panel.querySelector('#apf-btn');
    statusEl = panel.querySelector('#apf-status');
    sliderEl = panel.querySelector('#apf-slider');
    thumbA = panel.querySelector('#apf-thumb-a');
    thumbB = panel.querySelector('#apf-thumb-b');
    rangeLabelEl = panel.querySelector('#apf-range-label');
    sliderResetBtn = panel.querySelector('#apf-slider-reset');
    btn.addEventListener('click', () => (active ? deactivate() : activate()));
    panel.querySelector('#apf-save').addEventListener('click', saveLogs);
    for (const t of [thumbA, thumbB]) t.addEventListener('input', syncRange);
    sliderResetBtn.addEventListener('click', () => {
      thumbA.value = THRESHOLD;
      thumbB.value = SLIDER_MAX;
      syncRange();
    });
    thumbA.value = THRESHOLD;
    thumbB.value = SLIDER_MAX;
    syncRange();
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

  const onTrolley = () => /\/groceries\/trolley(\/|$|\?)/.test(location.pathname);

  const onSearch = () =>
    /\/groceries\//.test(location.pathname) &&
    !/\/groceries\/product\//.test(location.pathname) &&
    !onTrolley();

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
    if (trolleyPanel) {
      trolleyPanel.style.display = onTrolley() ? '' : 'none';
    }
  }

  /* -------------------------------------------------------------- trolley --- */

  // The trolley page renders each line item three times (once per responsive
  // layout breakpoint) with only one copy actually visible at a time, so a
  // plain querySelectorAll would triple- (or more) count products. Climbing
  // from each product link to its nearest ancestor that owns a quantity
  // stepper gives the per-item row; filtering to offsetParent !== null keeps
  // only the currently-rendered copy of each row.
  function trolleyRows() {
    const seen = new Set();
    const rows = [];
    document.querySelectorAll('a[href*="/groceries/product/"]').forEach((a) => {
      let url;
      try { url = new URL(a.getAttribute('href'), location.origin); } catch { return; }
      const seg = url.pathname.split('/').filter(Boolean).pop();
      if (!/^\d+$/.test(seg || '')) return;
      let row = a.parentElement, depth = 0;
      while (row && depth < 6 && !row.querySelector('[data-testid="update-plus-btn"]')) {
        row = row.parentElement;
        depth++;
      }
      if (!row || row.offsetParent === null || seen.has(row)) return;
      seen.add(row);
      const qtyInput = row.querySelector('input[type="number"]');
      const qty = qtyInput ? parseInt(qtyInput.value, 10) : 1;
      rows.push({ cin: seg, href: url.href, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 });
    });
    return rows;
  }

  async function nutritionForWithRetry(cin, href) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await nutritionFor(cin, href);
      if (r.status !== 'throttled') return r;
      await new Promise((res) => setTimeout(res, 30000));
    }
    return { status: 'unknown' };
  }

  let trolleyPanel, trolleyBtn, trolleyStatusEl;
  let trolleyRunning = false;

  async function runTrolleyAverage() {
    if (trolleyRunning) return;
    trolleyRunning = true;
    trolleyBtn.disabled = true;
    trolleyStatusEl.textContent = '';
    trolleyStatusEl.style.background = '';
    trolleyStatusEl.style.color = '';

    const rows = trolleyRows();
    if (!rows.length) {
      trolleyBtn.textContent = 'Calculate average';
      trolleyBtn.disabled = false;
      trolleyStatusEl.textContent = 'No products found in trolley.';
      trolleyRunning = false;
      return;
    }

    // "If I ate the whole trolley" means summing actual protein and kcal per line
    // item (per-100g figure scaled up by that product's pack weight and quantity),
    // not just averaging each item's ratio. Pack weight (r.grams) is resolved by
    // extractNutrition from unit price, size label, or per-serving nutrition — see
    // its comment. Only items where none of those apply fall back to an assumed
    // 100g so they still contribute something, flagged via sizeUnknown below.
    const ASSUMED_GRAMS = 100;
    let done = 0, totalProtein = 0, totalKcal = 0, totalQty = 0, unreadable = 0, sizeUnknown = 0;
    let idx = 0;
    trolleyBtn.textContent = 'Calculating… 0/' + rows.length;

    async function worker() {
      while (idx < rows.length) {
        const row = rows[idx++];
        const r = await nutritionForWithRetry(row.cin, row.href);
        if (r.status === 'ok') {
          const knownGrams = Number.isFinite(r.grams) && r.grams > 0;
          const grams = knownGrams ? r.grams : ASSUMED_GRAMS;
          if (!knownGrams) sizeUnknown += row.qty;
          totalProtein += r.protein * (grams / 100) * row.qty;
          totalKcal += r.kcal * (grams / 100) * row.qty;
          totalQty += row.qty;
        } else {
          unreadable++;
        }
        done++;
        trolleyBtn.textContent = 'Calculating… ' + done + '/' + rows.length;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

    trolleyBtn.textContent = 'Recalculate';
    trolleyBtn.disabled = false;
    trolleyRunning = false;

    if (totalKcal > 0) {
      const avg = (totalProtein / totalKcal) * 100;
      trolleyStatusEl.textContent = avg.toFixed(1) + ' g protein / 100 kcal for the whole trolley ('
        + Math.round(totalKcal) + ' kcal, ' + Math.round(totalProtein) + ' g protein, ' + totalQty + ' item' + (totalQty === 1 ? '' : 's') + ')';
      trolleyStatusEl.style.background = colorForRatio(avg);
      trolleyStatusEl.style.color = '#fff';
      if (unreadable) trolleyStatusEl.textContent += ' · ' + unreadable + ' unreadable';
      if (sizeUnknown) trolleyStatusEl.textContent += ' · ' + sizeUnknown + ' item' + (sizeUnknown === 1 ? '' : 's') + ' size unknown (assumed 100g)';
    } else {
      trolleyStatusEl.textContent = 'Could not read nutrition for any item.';
    }
  }

  function buildTrolleyPanel() {
    trolleyPanel = document.createElement('div');
    trolleyPanel.id = 'apf-trolley-panel';
    trolleyPanel.innerHTML =
      '<div id="apf-trolley-title">Trolley protein</div>' +
      '<button id="apf-trolley-btn" type="button">Calculate average</button>' +
      '<div id="apf-trolley-status"></div>';
    document.documentElement.appendChild(trolleyPanel);
    trolleyBtn = trolleyPanel.querySelector('#apf-trolley-btn');
    trolleyStatusEl = trolleyPanel.querySelector('#apf-trolley-status');
    trolleyBtn.addEventListener('click', runTrolleyAverage);
  }

  /* ------------------------------------------------------------------ init --- */

  function init() {
    if (document.getElementById('apf-panel')) return;
    buildPanel();
    buildTrolleyPanel();
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
