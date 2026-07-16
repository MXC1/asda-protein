# ASDA Protein Filter

A Chrome extension that filters [ASDA grocery **search** pages](https://www.asda.com/groceries/search/beans)
down to products that provide **at least 5.4 g of protein per 100 kcal**.

## What it does

On any `https://www.asda.com/groceries/search/...` page a small **Protein filter**
panel appears in the bottom-right corner. Click **Filter results** and the extension:

1. Finds every product card in the results grid.
2. Fetches each product's own page (same origin) and reads its nutrition.
3. Computes `protein_per_100g ÷ energy_kcal_per_100g × 100` (= grams of protein per 100 kcal).
4. Then, per the configured behaviour:
   - **≥ 5.4 g/100 kcal** → kept, badged with the value (e.g. `9.4 g/100kcal`) on a
     colour gradient from **red** at 5.4 g/100 kcal, through **amber** at 6.5, up to **green** at 7.6 g/100 kcal and above.
   - **< 5.4 g/100 kcal** → **hidden**.
   - **nutrition can't be read** (non-food items, missing data) → **hidden** too (counted
     separately as "?" in the status panel, in case that count is unexpectedly high).

Click the button again (now **Reset (show all)**) to restore every card.

On an individual **product page** (e.g. `https://www.asda.com/groceries/product/.../9369248`),
a small floating badge in the bottom-right corner shows that product's protein density —
e.g. `9.4 g protein / 100 kcal`, coloured on the same red-to-green gradient, or a grey
`Protein data unavailable` badge if it couldn't be read. This runs automatically, with no
button to click.

## How the nutrition data is sourced

This was reverse-engineered from ASDA's live responses:

- **Search results** come from an Algolia index that returns each product's `CIN`
  (product id) but **no nutrition** — so nutrition must be read per product.
- Each result card is a `.product-module` element containing
  `a[href="/groceries/product/.../{CIN}"]`.
- A **product page** is a Mobify/Salesforce PWA. Its data is server-side rendered into
  `<script id="mobify-data">`, where:

  ```
  __PRELOADED_STATE__.pageProps.pageData.initialProduct.c_BRANDBANK_JSON
  ```

  is itself a JSON string. Parsing it exposes `calculatedNutrition[]`:

  ```json
  { "nameId": "1183", "nameValue": "Energy (kcal)", "per100": 81,  "perServing": 168 }
  { "nameId": "1184", "nameValue": "Protein (g)",   "per100": 4.8, "perServing": 10  }
  ```

  The extension reads the `per100` values (falling back to the raw `nutrition[]`
  table if `calculatedNutrition` is absent).

  > Worked example — Heinz Baked Beans: 4.8 g protein ÷ 81 kcal × 100 = **5.9 g/100 kcal → kept**,
  > badged just past the red end of the gradient (bar starts at 5.4 g/100 kcal).

There is no public unauthenticated JSON endpoint for a single product (the Salesforce
Commerce API returns `401` without a bearer token), so the extension fetches the product
page HTML and parses the embedded state. Results are cached per product id (in-memory and
`sessionStorage`) so re-running or scrolling never re-fetches the same product.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`asda-protein`).
4. Go to an ASDA search page, e.g. <https://www.asda.com/groceries/search/beans>, and click **Filter results**.

No toolbar icon is bundled, so Chrome shows the default puzzle-piece icon — that's expected.

## Notes & limitations

- **Manual trigger by design.** Nothing is fetched until you click the button.
- **Lazy loading / infinite scroll.** ASDA only renders a handful of cards at first and
  loads more as you scroll. While the filter is active, newly loaded cards are filtered
  automatically. If most results on screen get hidden there may be little left to scroll,
  which can make it harder to trigger the next batch — scroll the window to load more, then
  they'll be filtered too.
- **Badges on kept items** show the computed density, coloured on a red-to-green gradient. If
  you'd prefer no badge on passing items, remove the `setBadge(...)` call in the `pass` branch
  of `apply()` in `content.js`.
- **Threshold** is the `THRESHOLD` constant at the top of `content.js` (default `5.4`). The
  gradient's amber midpoint and green end are the separate `GRADIENT_MID` (default `6.5`) and
  `GRADIENT_MAX` (default `7.6`) constants.
- Filtering runs over every `.product-module` on the page, which includes sponsored results
  and any "you might also like" carousels.
- Selectors and the embedded-state path reflect ASDA's site as of mid-2026; if ASDA changes
  its markup or data shape, update the constants/paths in `content.js`.
