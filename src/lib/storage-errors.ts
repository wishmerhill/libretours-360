/**
 * Typed storage errors and a tiny notification channel for storage events
 * that happen outside a user action (e.g. a project restored from its backup
 * while the dashboard loads), so the UI can surface them as toasts.
 */

export type StorageErrorCode =
  "FileNotFound" | "CorruptFile" | "PermissionDenied" | "InvalidKey" | "IoError";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly path: string | undefined;

  constructor(
    code: StorageErrorCode,
    message: string,
    options?: { path?: string | undefined; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StorageError";
    this.code = code;
    this.path = options?.path;
  }
}

/** Thrown when project data does not match the project schema. */
export class ProjectValidationError extends Error {
  readonly issues: string[];
  /** "UnsupportedVersion": written by a newer app version; "Invalid": everything else. */
  readonly reason: "Invalid" | "UnsupportedVersion";

  constructor(issues: string[], reason: "Invalid" | "UnsupportedVersion" = "Invalid") {
    const shown = issues.slice(0, 3).join("; ");
    const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
    super(`Invalid project: ${shown}${more}`);
    this.name = "ProjectValidationError";
    this.issues = issues;
    this.reason = reason;
  }
}

export function isStorageError(e: unknown, code?: StorageErrorCode): e is StorageError {
  return e instanceof StorageError && (code === undefined || e.code === code);
}

/**
 * Tauri plugin errors are plain strings (e.g. "forbidden path: ..."), Node/OS
 * errors are Error objects. Map both onto our error codes.
 */
export function classifyFsError(e: unknown, path?: string): StorageError {
  if (e instanceof StorageError) return e;
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const code = (e as { code?: string } | null)?.code;

  if (
    code === "EACCES" ||
    code === "EPERM" ||
    /forbidden path|not allowed|permission denied|access is denied|os error (5|13)\b/i.test(text)
  ) {
    return new StorageError(
      "PermissionDenied",
      `Permission denied${path ? ` for ${path}` : ""}: ${text}`,
      { path, cause: e },
    );
  }
  if (
    code === "ENOENT" ||
    /no such file|not found|cannot find the (file|path)|os error (2|3)\b/i.test(text)
  ) {
    return new StorageError("FileNotFound", `File not found${path ? `: ${path}` : ""}`, {
      path,
      cause: e,
    });
  }
  return new StorageError("IoError", `I/O error${path ? ` on ${path}` : ""}: ${text}`, {
    path,
    cause: e,
  });
}

/** A user-facing sentence for any error coming out of the storage layer. */
export function describeStorageError(e: unknown): string {
  if (e instanceof StorageError) {
    switch (e.code) {
      case "PermissionDenied":
        return "The app is not allowed to access its data folder. Check the folder permissions.";
      case "FileNotFound":
        return "A required file could not be found.";
      case "CorruptFile":
        return e.message;
      case "InvalidKey":
        return "A file reference contains characters that are not allowed.";
      case "IoError":
        return "A disk error occurred. Check that there is free space and that the folder is writable.";
    }
  }
  if (e instanceof ProjectValidationError) return e.message;
  if (e instanceof DOMException && e.name === "QuotaExceededError") {
    return "Browser storage is full.";
  }
  return e instanceof Error ? e.message : String(e);
}

// ─── Storage issue notifications ───────────────────────────────────────────

export interface StorageIssue {
  level: "warning" | "error";
  /** Stable id, used to de-duplicate toasts. */
  id: string;
  title: string;
  description?: string;
}

type Listener = (issue: StorageIssue) => void;

const listeners = new Set<Listener>();
// Issues raised before the UI is listening (app start-up) are kept and replayed.
const buffered: StorageIssue[] = [];
const MAX_BUFFERED = 20;

export function reportStorageIssue(issue: StorageIssue): void {
  if (issue.level === "error") console.error(`[storage] ${issue.title}`, issue.description ?? "");
  else console.warn(`[storage] ${issue.title}`, issue.description ?? "");

  if (listeners.size === 0) {
    if (buffered.length < MAX_BUFFERED) buffered.push(issue);
    return;
  }
  listeners.forEach((l) => l(issue));
}

export function subscribeStorageIssues(listener: Listener): () => void {
  listeners.add(listener);
  buffered.splice(0).forEach(listener);
  return () => {
    listeners.delete(listener);
  };
}
