import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register(`${appBase}/sw.js`, { scope: `${appBase}/` }));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
