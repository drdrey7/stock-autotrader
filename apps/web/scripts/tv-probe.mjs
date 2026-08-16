#!/usr/bin/env node
/**
 * Empirical probe for TradingView Web Components (August 2026).
 *
 * Loads the official <tv-ticker-tape> and <tv-market-overview> custom elements
 * in a real browser, feeds them candidate symbol configs, and dumps what each
 * one actually rendered (including shadow roots) so we can verify real values
 * vs error/empty states before committing any symbol to the app config.
 *
 * This is a development tool, not part of the E2E suite. Run manually:
 *   node scripts/tv-probe.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".tv-probe");
mkdirSync(OUT, { recursive: true });

// Serve the probe over HTTP — TradingView's module loader rejects a null
// origin (about:blank) with a 400 from its sherif service.
const probeHtmlString = () => probeHtml(TICKER_SYMBOLS, MO_SECTIONS);
const server = createServer((_req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(probeHtmlString());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PROBE_URL = `http://127.0.0.1:${server.address().port}/`;

const TICKER_SYMBOLS = [
  "FOREXCOM:SPXUSD",     // S&P 500 (official example)
  "FOREXCOM:NSXUSD",     // Nasdaq-100 (official example)
  "FOREXCOM:DJI",        // Dow Jones (official example)
  "VIX",                 // VIX (bare — verified, TVC:/CBOE: feeds fail)
  "CMCMARKETS:GOLD",     // Gold (official example)
  "BITSTAMP:BTCUSD",     // Bitcoin (official example)
  "BITSTAMP:ETHUSD",     // Ether (official example)
  "COINBASE:SOLUSD",     // Solana candidate
  "FX:EURUSD",           // EUR/USD (official example)
].join(",");

// Candidate sweep for the sections that showed failures: futures, bonds and
// the VIX feeds. Rows render in symbol order, so failures correlate by index.
const MO_SECTIONS = [
  {
    sectionName: "Indices",
    symbols: ["FOREXCOM:SPXUSD", "FOREXCOM:NSXUSD", "FOREXCOM:DJI", "VIX", "TVC:VIX", "CBOE:VIX"],
  },
  {
    sectionName: "Futures",
    symbols: [
      "CMCMARKETS:GOLD", "TVC:GOLD", "USOIL", "WTIUSD",
      "XAGUSD", "CMCMARKETS:SILVER", "TVC:SILVER", "SILVER",
    ],
  },
  {
    sectionName: "Bonds",
    symbols: ["US10Y", "EUREX:FGBL1!"],
  },
  {
    sectionName: "Crypto",
    symbols: ["BITSTAMP:BTCUSD", "BITSTAMP:ETHUSD", "COINBASE:SOLUSD"],
  },
];

const probeHtml = (symbols, sections) => `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f7f8f7;font-family:system-ui">
  <h3>Ticker tape</h3>
  <div id="ticker" style="width:900px;border:1px solid #ddd">
    <tv-ticker-tape symbols="${symbols}" color-theme="light"></tv-ticker-tape>
  </div>
  <h3>Market overview</h3>
  <div id="market" style="width:600px;border:1px solid #ddd">
    <tv-market-overview mode="custom" time-frame="12M" color-theme="light"
      symbol-sectors='${JSON.stringify(sections)}'>
    </tv-market-overview>
  </div>
  <script type="module" src="https://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js"></script>
  <script type="module" src="https://widgets.tradingview-widget.com/w/en/tv-market-overview.js"></script>
</body></html>`;

async function dumpShallow(handle, label, indent = "  ") {
  const parts = await handle.evaluate((root) => {
    const lines = [];
    const walk = (node, depth) => {
      const isRoot = node instanceof ShadowRoot || node instanceof DocumentFragment;
      const tag = isRoot ? (node instanceof ShadowRoot ? "#shadow-root" : "#fragment") : node.tagName.toLowerCase();
      const cls = !isRoot && node.className ? `.${String(node.className).split(" ").join(".")}` : "";
      const text = !isRoot && node.childNodes.length <= 1 && node.textContent ? ` "${node.textContent.trim().slice(0, 60)}"` : "";
      lines.push(`${"  ".repeat(depth)}${tag}${cls}${text}`);
      if (node.shadowRoot) {
        walk(node.shadowRoot, depth + 1);
      }
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return lines;
  });
  writeFileSync(path.join(OUT, `${label}.dom.txt`), parts.join("\n"));
  console.log(`${indent}${label}: ${parts.length} nodes written to .tv-probe/${label}.dom.txt`);
}

async function dumpTvFrame(page, label, indent = "  ") {
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("tradingview-widget"));
  if (!frame) {
    console.log(`${indent}${label}: no tradingview-widget frame found`);
    return null;
  }
  // Walk the frame's document including shadow roots and text nodes.
  const lines = await frame
    .evaluate(() => {
      const out = [];
      const walk = (node, d) => {
        if (node.nodeType === 3) {
          const t = node.textContent.trim();
          if (t) out.push(`${"  ".repeat(d)}text "${t.slice(0, 90)}"`);
        }
        if (node.shadowRoot) {
          out.push(`${"  ".repeat(d)}#shadow-root`);
          walk(node.shadowRoot, d + 1);
        }
        for (const child of node.children) walk(child, d + 1);
      };
      walk(document.body, 0);
      return out;
    })
    .catch((e) => [`evaluate ERR ${e.message}`]);
  writeFileSync(path.join(OUT, `${label}.frame.txt`), lines.join("\n"));
  console.log(`${indent}${label}: iframe DOM walked (${lines.length} text nodes) -> .tv-probe/${label}.frame.txt`);
  return frame;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const consoleErrors = [];
const failedRequests = [];
const symbolLogos = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });
page.on("pageerror", (err) => consoleErrors.push(`PAGEERROR ${err.message.slice(0, 300)}`));
page.on("requestfailed", (req) => failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText}`));
page.on("response", (res) => {
  const url = res.url();
  if (url.includes("s3-symbol-logo.tradingview.com")) {
    symbolLogos.push(decodeURIComponent(url.split("?")[0].split("/").slice(-2).join("/")));
  }
  if (!url.includes("tradingview")) return;
  const status = res.status();
  if (status >= 400 || (status !== 200 && status !== 204)) {
    failedRequests.push(`[${status}] ${res.request().resourceType()} ${url}`);
  }
});

// TradingView web components use CLOSED shadow roots, which Playwright locators
// cannot pierce. Record every root via attachShadow interception so we can read
// the rendered widget DOM from page.evaluate. Runs before any page script.
await page.addInitScript(() => {
  const realAttachShadow = Element.prototype.attachShadow;
  window.__tvShadowRoots = new Map();
  Element.prototype.attachShadow = function (init) {
    const root = realAttachShadow.call(this, init);
    try {
      window.__tvShadowRoots.set(this, root);
    } catch {
      /* ignore */
    }
    return root;
  };
});

await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
page.setDefaultTimeout(15_000);

const registered = await page.evaluate(() =>
  ["tv-ticker-tape", "tv-market-overview"].map((n) => `${n}:${!!window.customElements.get(n)}`),
);
console.log("registered:", registered.join(", "));
console.log("page title:", await page.title());

// Give the modules time to load and fetch quotes.
await page.waitForTimeout(6000);

// The widgets render into CLOSED shadow roots (el.shadowRoot === null), which
// is why we recorded them via attachShadow interception above. We now read the
// rendered widget DOM straight from those recorded roots.

async function readTicker(page) {
  return page.evaluate(() => {
    const el = document.querySelector("tv-ticker-tape");
    const root = window.__tvShadowRoots?.get(el);
    if (!root) return { error: "no recorded shadow root for tv-ticker-tape" };
    // Collect text from a node's subtree across open AND closed shadow roots
    // (closed roots are in the __tvShadowRoots map, not on node.shadowRoot).
    const collectText = (node) => {
      const parts = [];
      const walk = (n) => {
        if (n.nodeType === 3) parts.push(n.textContent);
        const closed = window.__tvShadowRoots.get(n);
        if (n.shadowRoot) walk(n.shadowRoot);
        if (closed && closed !== n.shadowRoot) walk(closed);
        for (const child of n.children) walk(child);
      };
      walk(node);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        const tag = child.tagName.toLowerCase();
        if (tag === "tv-ticker-chart-item") {
          const itemRoot = window.__tvShadowRoots.get(child);
          // The item renders its symbol name as direct light-DOM text in its own
          // closed root; the price lives deeper in tv-price-with-change.
          let price = "";
          const priceFind = (n) => {
            for (const c of n.children) {
              if (c.tagName.toLowerCase() === "tv-price-with-change") {
                price = collectText(c);
                return;
              }
              const cr = window.__tvShadowRoots.get(c);
              if (c.shadowRoot) priceFind(c.shadowRoot);
              if (cr && cr !== c.shadowRoot) priceFind(cr);
              priceFind(c);
            }
          };
          if (itemRoot) priceFind(itemRoot);
          out.push({
            symbol: child.getAttribute("data-symbol"),
            name: itemRoot ? itemRoot.textContent.replace(/\s+/g, " ").trim().slice(0, 40) : "",
            price: price.slice(0, 40),
          });
        }
        const closed = window.__tvShadowRoots.get(child);
        if (child.shadowRoot) walk(child.shadowRoot);
        if (closed && closed !== child.shadowRoot) walk(closed);
        walk(child);
      }
    };
    walk(root);
    return { items: out };
  });
}

async function clickSection(page, name) {
  await page.evaluate((sectionName) => {
    const el = document.querySelector("tv-market-overview");
    const root = window.__tvShadowRoots?.get(el);
    const find = (node) => {
      for (const child of node.children) {
        // The clickable tab is the deepest element whose text is exactly the
        // section name (a <button> or option item inside tv-option-bar).
        const text = (child.textContent || "").trim();
        if (text === sectionName && child.children.length === 0) {
          child.click();
          return true;
        }
        const closed = window.__tvShadowRoots.get(child);
        if (child.shadowRoot && find(child.shadowRoot)) return true;
        if (closed && closed !== child.shadowRoot && find(closed)) return true;
        if (find(child)) return true;
      }
      return false;
    };
    find(root);
  }, name);
}

async function readMarketRows(page) {
  return page.evaluate(() => {
    const el = document.querySelector("tv-market-overview");
    const root = window.__tvShadowRoots?.get(el);
    if (!root) return { error: "no recorded shadow root for tv-market-overview" };
    const collectText = (node) => {
      const parts = [];
      const walk = (n) => {
        if (n.nodeType === 3) parts.push(n.textContent);
        const closed = window.__tvShadowRoots.get(n);
        if (n.shadowRoot) walk(n.shadowRoot);
        if (closed && closed !== n.shadowRoot) walk(closed);
        for (const child of n.children) walk(child);
      };
      walk(node);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        const tag = child.tagName.toLowerCase();
        if (tag === "tv-ticker-item") {
          const rowRoot = window.__tvShadowRoots.get(child);
          let price = "";
          const priceFind = (n) => {
            for (const c of n.children) {
              if (c.tagName.toLowerCase() === "tv-price-with-change") {
                price = collectText(c);
                return;
              }
              const cr = window.__tvShadowRoots.get(c);
              if (c.shadowRoot) priceFind(c.shadowRoot);
              if (cr && cr !== c.shadowRoot) priceFind(cr);
              priceFind(c);
            }
          };
          if (rowRoot) priceFind(rowRoot);
          out.push({
            symbol: child.symbol ?? child.getAttribute("symbol"),
            name: rowRoot ? rowRoot.textContent.replace(/\s+/g, " ").trim().slice(0, 40) : "",
            price: price.slice(0, 40),
          });
        }
        const closed = window.__tvShadowRoots.get(child);
        if (child.shadowRoot) walk(child.shadowRoot);
        if (closed && closed !== child.shadowRoot) walk(closed);
        walk(child);
      }
    };
    walk(root);
    return { rows: out };
  });
}

// --- Ticker: every tv-ticker-chart-item, keyed by data-symbol ---
console.log("\n=== TICKER ITEMS (via recorded closed shadow root) ===");
const ticker = await readTicker(page);
if (ticker.error) {
  console.log(`  ${ticker.error}`);
} else {
  console.log(`  count: ${ticker.items.length}`);
  for (const it of ticker.items) {
    const status = it.name ? "OK " : "FAIL";
    console.log(`  [${status}] ${it.symbol ?? "?"} -> "${it.name}" price="${it.price}"`);
  }
  writeFileSync(path.join(OUT, "ticker.rows.txt"), ticker.items.map((i) => `${i.symbol}\t${i.name}\t${i.price}`).join("\n"));
}

// --- Market Overview: click each section tab, read the rendered rows ---
console.log("\n=== MARKET OVERVIEW (per section) ===");
for (const section of MO_SECTIONS) {
  const name = section.sectionName;
  await clickSection(page, name);
  await page.waitForTimeout(1400);
  const { rows, error } = await readMarketRows(page);
  const expected = section.symbols;
  const rowLines = (rows ?? []).map((r, i) => {
    const sym = expected[i] ?? "?";
    const status = r.name && r.price ? "OK " : r.name ? "NAME" : "FAIL";
    return `${status} ${sym}\t${r.name || ""}\t${r.price || ""}`;
  });
  writeFileSync(path.join(OUT, `mo-${name.toLowerCase()}.txt`), rowLines.join("\n"));
  console.log(`  [${error ? error : "tab-clicked"}] ${name}: ${rowLines.length} rows`);
  for (const line of rowLines) console.log(`    ${line}`);
}

console.log("\n=== SYMBOL LOGOS REQUESTED (per rendered symbol) ===");
for (const l of symbolLogos) console.log(`  ${l}`);

await dumpShallow(page.locator("body"), "full-page");
await page.screenshot({ path: path.join(OUT, "page.png"), fullPage: false });

console.log("\n=== CONSOLE ERRORS ===");
for (const e of consoleErrors) console.log(`  ${e}`);
console.log("\n=== FAILED / HIGH-STATUS REQUESTS ===");
for (const r of failedRequests) console.log(`  ${r}`);
console.log(`\nProbe output written to ${OUT}`);
await browser.close();
server.close();
