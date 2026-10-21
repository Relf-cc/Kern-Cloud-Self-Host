/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/pages.css";
import { initAppearance } from "./stores/appearance";
import { App } from "./app/App";

// index.html sets the theme before the first paint; this re-applies the whole
// saved set from one place, so the two can't drift.
initAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
