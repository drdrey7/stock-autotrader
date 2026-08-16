// Shared helpers for the TradingView E2E specs (tv-csp.spec.mjs, tv-live.spec.mjs).
//
// TradingView's web components (<tv-ticker-tape>, <tv-market-overview>) render
// into CLOSED shadow roots (el.shadowRoot === null), so Playwright's normal
// locators cannot see their content. installShadowRootProbe re-installs
// Element.prototype.attachShadow before any page script runs and records every
// created shadow root in window.__tvShadowRoots. The read* helpers then walk
// those recorded roots exactly the way scripts/tv-probe.mjs validated the
// symbol config — the probe output is committed under scripts/.tv-probe/.

/** Parse a Content-Security-Policy header into a Map of directive -> sources. */
export function parseCsp(header) {
  const directives = new Map();
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) directives.set(name, rest);
  }
  return directives;
}

/**
 * Record every closed shadow root into window.__tvShadowRoots (Map<element,
 * root>). Must be called before the page navigates.
 */
export async function installShadowRootProbe(page) {
  await page.addInitScript(() => {
    const roots = new Map();
    Object.defineProperty(window, "__tvShadowRoots", { value: roots, configurable: true });
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      roots.set(this, root);
      return root;
    };
  });
}

/**
 * Attach a listener capturing every CSP-blocked request. Chrome reports these
 * as console errors ("Refused to … because it violates the following Content
 * Security Policy directive") and as net::ERR_BLOCKED_BY_CSP request failures.
 */
export function collectCspViolations(page) {
  const violations = [];
  const isViolation = (text) =>
    /violates the following Content Security Policy|Refused to (execute|load|connect|frame|send|run)/i.test(text);
  page.on("console", (msg) => {
    if (isViolation(msg.text())) violations.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (isViolation(String(err))) violations.push(String(err));
  });
  page.on("requestfailed", (req) => {
    const errorText = req.failure()?.errorText ?? "";
    if (/ERR_BLOCKED_BY_CSP|Content Security Policy/i.test(errorText)) {
      violations.push(`request blocked: ${req.url()} — ${errorText}`);
    }
  });
  return violations;
}

/** Wait until a TradingView custom element is registered (module loaded). */
export async function waitForTradingViewElement(page, tagName, timeout = 20_000) {
  await page.waitForFunction(
    (tag) => typeof window.customElements !== "undefined" && Boolean(window.customElements.get(tag)),
    tagName,
    { timeout },
  );
}

/**
 * Read the rendered ticker items as [{ symbol, name, text }] from the recorded
 * closed shadow root, mirroring scripts/tv-probe.mjs. `text` is the full
 * collected text of the item across every nested shadow root, so a dead-feed
 * placeholder (-----) is caught wherever TradingView renders it.
 */
export async function readTickerItems(page) {
  return page.evaluate(() => {
    const el = document.querySelector("tv-ticker-tape");
    const root = window.__tvShadowRoots?.get(el);
    if (!root) return { error: "no recorded shadow root for tv-ticker-tape" };
    // Collect text from a node's subtree across open AND closed shadow roots.
    // Iterates childNodes (not children) so direct text nodes of a shadow root
    // are included — TradingView puts values there.
    const collectText = (node) => {
      const parts = [];
      const walk = (n) => {
        for (const child of n.childNodes) {
          if (child.nodeType === 3) {
            parts.push(child.textContent);
          } else {
            const closed = window.__tvShadowRoots.get(child);
            if (child.shadowRoot) walk(child.shadowRoot);
            if (closed && closed !== child.shadowRoot) walk(closed);
            walk(child);
          }
        }
      };
      walk(node);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName?.toLowerCase() === "tv-ticker-chart-item") {
          const itemRoot = window.__tvShadowRoots.get(child);
          const text = itemRoot ? collectText(itemRoot) : "";
          out.push({
            symbol: child.getAttribute("data-symbol"),
            name: text.slice(0, 40),
            text: text.slice(0, 120),
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

/** Click the market-overview section tab whose text is exactly `name`. */
export async function clickMarketOverviewSection(page, name) {
  return page.evaluate((sectionName) => {
    const el = document.querySelector("tv-market-overview");
    const root = window.__tvShadowRoots?.get(el);
    const find = (node) => {
      for (const child of node.children) {
        // The clickable tab is the deepest element whose text is exactly the
        // section name (a <button> / option item inside tv-option-bar).
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
    return find(root);
  }, name);
}

/**
 * Read the active market-overview section's rendered rows as [{ name, text }].
 * TradingView's market-overview rows do not expose a per-row symbol attribute,
 * so each row's full collected text (which includes the short label, the value
 * and the change) is returned; rows render in the order of the configured
 * `symbol-sectors` array.
 */
export async function readMarketRows(page) {
  return page.evaluate(() => {
    const el = document.querySelector("tv-market-overview");
    const root = window.__tvShadowRoots?.get(el);
    if (!root) return { error: "no recorded shadow root for tv-market-overview" };
    const collectText = (node) => {
      const parts = [];
      const walk = (n) => {
        for (const child of n.childNodes) {
          if (child.nodeType === 3) {
            parts.push(child.textContent);
          } else {
            const closed = window.__tvShadowRoots.get(child);
            if (child.shadowRoot) walk(child.shadowRoot);
            if (closed && closed !== child.shadowRoot) walk(closed);
            walk(child);
          }
        }
      };
      walk(node);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName?.toLowerCase() === "tv-ticker-item") {
          const rowRoot = window.__tvShadowRoots.get(child);
          const text = rowRoot ? collectText(rowRoot) : "";
          out.push({ name: text.slice(0, 40), text: text.slice(0, 160) });
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

/**
 * Probe whether TradingView's widget hosts are reachable from this machine. A
 * provider outage (network-level) must skip the live assertions, never fail
 * them — a reachable provider that renders a dead feed is a config regression.
 */
export async function tradingViewReachable(timeoutMs = 6_000) {
  try {
    const res = await fetch("https://s3.tradingview.com/external-embedding/embed-widget-events.js", {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok
      ? { reachable: true, detail: `HTTP ${res.status}` }
      : { reachable: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, detail: String(err?.message ?? err) };
  }
}

/** Dead-feed placeholders the datafeed renders for a symbol it cannot serve. */
export const DEAD_FEED_MARKERS = ["-----", "No data here yet"];
