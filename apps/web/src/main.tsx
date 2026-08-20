import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./branding/tokens.css";
import "./styles.css";
import "./daily-briefing.css";
// The Morning Briefing stylesheet must come last: Vite hoists component CSS
// ahead of the entry's direct imports, so importing it from the component
// (as it was originally) let the global .hero/.eyebrow/.table-head rules win
// the cascade over the scoped Morning Briefing rules. Keep it here, after the
// globals, so the app's component styles are the final authority.
import "./morning-briefing/morning-briefing.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
