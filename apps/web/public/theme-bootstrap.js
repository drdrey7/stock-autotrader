(() => {
  let theme = "dark";

  try {
    const stored = localStorage.getItem("how-are-the-markets-theme");
    const legacy = localStorage.getItem("morning-briefing-theme");
    if (stored === "light" || stored === "dark") theme = stored;
    else if (legacy === "light" || legacy === "dark") theme = legacy;
  } catch {
    // Storage may be unavailable; the product default remains dark.
  }

  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#080d1a" : "#f7f9fc");
})();
