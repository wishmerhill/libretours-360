/**
 * Environment detection utility for Tauri v2.
 *
 * Provides a single source of truth for checking whether the app
 * is running inside a Tauri WebView or a standard browser.
 */

/**
 * Returns `true` when the current runtime is a Tauri WebView.
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] !== undefined;
}

/**
 * Returns `true` when the current runtime is a standard browser
 * (including SSR / server-side rendering).
 */
export function isBrowser(): boolean {
  return !isTauri();
}