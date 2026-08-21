import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import { ensureDirectories } from "./lib/tauri-storage";

// Ensure required Tauri app data directories exist on startup.
// This is a no-op when running in a standard browser.
ensureDirectories().catch(() => {
  // Silently ignore — graceful fallback to browser storage
});

const router = getRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
