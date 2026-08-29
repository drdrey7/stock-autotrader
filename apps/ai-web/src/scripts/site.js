const themeKey = "ai-web-theme";

function applyTheme(theme) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.themeChoice === (localStorage.getItem(themeKey) || "system"));
  });
}

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    const choice = button.dataset.themeChoice || "system";
    if (choice === "system") localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, choice);
    applyTheme(choice);
  });
});
applyTheme(localStorage.getItem(themeKey) || "system");

const menuToggle = document.querySelector("[data-menu-toggle]");
const mobileMenu = document.querySelector("[data-mobile-menu]");
menuToggle?.addEventListener("click", () => {
  const open = mobileMenu?.hasAttribute("hidden") ?? true;
  if (!mobileMenu) return;
  mobileMenu.toggleAttribute("hidden", !open);
  menuToggle.setAttribute("aria-expanded", String(open));
});

function safeSymbol(form) {
  const value = new FormData(form).get("symbol");
  return typeof value === "string" && /^[A-Za-z]{1,8}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

async function hasSession() {
  try {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.user && typeof body.user.id === "string" ? body.user : null;
  } catch { return null; }
}

document.querySelectorAll("[data-ticker]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector("input[name='symbol']");
    if (input) { input.value = button.dataset.ticker || ""; input.focus(); }
  });
});

document.querySelectorAll("[data-analyze-form]").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = form.querySelector("[data-form-message]");
    const symbol = safeSymbol(form);
    if (!symbol) { if (message) message.textContent = "Enter a valid ticker using letters only."; return; }
    if (message) message.textContent = "Checking your workspace…";
    const user = await hasSession();
    if (!user) { window.location.href = `/auth?returnTo=${encodeURIComponent(`/app?symbol=${symbol}`)}`; return; }
    if (window.location.pathname === "/app") {
      if (message) message.textContent = `${symbol} is ready. The complete analysis run opens in PR2.`;
      return;
    }
    window.location.href = `/app?symbol=${symbol}`;
  });
});

function safeReturnTo(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

let authMode = "sign-in";
const authForm = document.querySelector("[data-auth-form]");
if (authForm) {
  const nameField = document.querySelector("[data-name-field]");
  const title = document.querySelector("#auth-title");
  const subtitle = document.querySelector("[data-auth-subtitle]");
  const submit = document.querySelector("[data-auth-submit]");
  const message = document.querySelector("[data-auth-message]");
  document.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => {
    authMode = button.dataset.authMode || "sign-in";
    document.querySelectorAll("[data-auth-mode]").forEach((item) => item.classList.toggle("is-active", item === button));
    nameField?.toggleAttribute("hidden", authMode !== "sign-up");
    document.querySelector("#auth-password")?.setAttribute("autocomplete", authMode === "sign-up" ? "new-password" : "current-password");
    if (title) title.textContent = authMode === "sign-up" ? "Create your workspace" : "Welcome back";
    if (subtitle) subtitle.textContent = authMode === "sign-up" ? "Start keeping your research in one place." : "Sign in to open your workspace.";
    if (submit) submit.innerHTML = `${authMode === "sign-up" ? "Create account" : "Sign in"} <span aria-hidden="true">↗</span>`;
    if (message) message.textContent = "";
  }));
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (message) message.textContent = "";
    if (submit) { submit.disabled = true; submit.textContent = authMode === "sign-up" ? "Creating…" : "Signing in…"; }
    const values = Object.fromEntries(new FormData(authForm).entries());
    const endpoint = authMode === "sign-up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(authMode === "sign-up" ? { name: values.name, email: values.email, password: values.password } : { email: values.email, password: values.password, rememberMe: true }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.error) throw new Error(body?.message || body?.error?.message || body?.error || "Unable to authenticate.");
      const requested = new URLSearchParams(window.location.search).get("returnTo");
      window.location.href = safeReturnTo(requested);
    } catch (error) {
      if (message) message.textContent = error instanceof Error ? error.message : "Unable to authenticate. Try again.";
      if (submit) { submit.disabled = false; submit.innerHTML = `${authMode === "sign-up" ? "Create account" : "Sign in"} <span aria-hidden="true">↗</span>`; }
    }
  });
}

async function bootSession() {
  const user = await hasSession();
  document.querySelectorAll("[data-auth-state]").forEach((element) => { element.textContent = user ? (user.name || user.email || "Account") : "Sign in"; });
  document.querySelectorAll("[data-account-link]").forEach((element) => element.setAttribute("href", user ? "/app" : "/auth"));
  const app = document.querySelector("[data-app-state]");
  if (!app) return;
  if (!user) { app.setAttribute("data-app-state", "signed-out"); return; }
  app.setAttribute("data-app-state", "ready");
  document.querySelector("[data-user-name]").textContent = user.name || "Researcher";
  document.querySelector("[data-user-email]").textContent = user.email || "";
  try {
    const [viewerResponse, historyResponse] = await Promise.all([fetch("/api/ai-analysis/viewer", { credentials: "same-origin", cache: "no-store" }), fetch("/api/ai-analysis/history?limit=5", { credentials: "same-origin", cache: "no-store" })]);
    if (viewerResponse.ok) { const viewer = await viewerResponse.json(); document.querySelector("[data-credits]").textContent = String(viewer.creditsRemaining ?? "—"); }
    const history = document.querySelector("[data-history]");
    if (!historyResponse.ok) throw new Error("history unavailable");
    const body = await historyResponse.json();
    if (!body.items?.length) { history.innerHTML = `<div class="empty-history"><span class="empty-illustration" aria-hidden="true">◌</span><p>Your completed research will appear here.</p></div>`; return; }
    history.replaceChildren(...body.items.map((item) => {
      const row = document.createElement("div");
      row.className = "history-row";
      for (const [value, className] of [[item.symbol, "history-symbol"], [item.company || "Research brief", "history-company"], [new Date(item.requestedAt).toLocaleDateString(), "history-date"], [item.status, "history-status"]]) {
        const cell = document.createElement("span");
        cell.className = className;
        cell.textContent = String(value ?? "");
        row.append(cell);
      }
      return row;
    }));
  } catch { const history = document.querySelector("[data-history]"); if (history) history.innerHTML = `<div class="empty-history"><p>Research history is temporarily unavailable.</p></div>`; }
}

document.querySelector("[data-sign-out]")?.addEventListener("click", async () => {
  const message = document.querySelector("[data-account-message]");
  try { const response = await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" }); if (!response.ok) throw new Error(); window.location.href = "/auth"; } catch { if (message) message.textContent = "Unable to sign out. Try again."; }
});

bootSession();
