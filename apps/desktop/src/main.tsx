import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { TruncatedTextTooltip } from "./ui/TruncatedTextTooltip";
import "./styles/global.css";
import "./styles/controls.css";
import "./styles/settings.css";
import "./styles/telnet.css";
import "./styles/projects.css";
import "./styles/tools.css";
import "./styles/desktop-materials.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Application root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <App />
    <TruncatedTextTooltip />
  </StrictMode>,
);
