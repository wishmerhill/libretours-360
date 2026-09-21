import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import { ensureDirectories } from "./lib/tauri-storage";
import { describeStorageError, reportStorageIssue } from "./lib/storage-errors";

// Ensure required Tauri app data directories exist on startup.
// This is a no-op when running in a standard browser.
ensureDirectories().catch((e) => {
  reportStorageIssue({
    level: "error",
    id: "init-directories",
    title: "Cannot prepare the data folder",
    description: describeStorageError(e),
  });
});

const router = getRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
