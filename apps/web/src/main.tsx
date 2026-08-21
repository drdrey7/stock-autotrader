import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./branding/tokens.css";
import "./styles.css";
import "./daily-briefing.css";
// The Morning Briefing stylesheet must follow the global styles: Vite hoists
// component CSS and the global .hero/.eyebrow/.table-head rules would otherwise
// win the cascade over the scoped Morning Briefing rules.
import "./morning-briefing/morning-briefing.css";
// Shared typography policy for the public product. Its selectors are scoped
// through .shell with enough specificity to remain authoritative even when a
// lazy route injects feature CSS after this entry stylesheet.
import "./typography.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
