import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "./Settings.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
