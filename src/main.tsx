import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import { getStorageProvider } from "./lib/storage-provider";
import { describeStorageError, reportStorageIssue } from "./lib/storage-errors";

// Prepare the storage on startup: the data folder (desktop) or the database and
// the migration of data saved by earlier versions (browser).
getStorageProvider()
  .init()
  .catch((e) => {
    reportStorageIssue({
      level: "error",
      id: "init-storage",
      title: "Cannot prepare the storage",
      description: describeStorageError(e),
    });
  });

const router = getRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
