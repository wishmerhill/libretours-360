/**
 * Validation of identifiers that end up in file names inside $APPDATA
 * (project ids, panorama storage keys).
 *
 * Only letters, digits, "_", "-" and "." are allowed, which excludes path
 * separators ("/" and "\"), drive prefixes (":") and NUL bytes. On top of the
 * character whitelist we reject:
 *  - ".." anywhere (path traversal),
 *  - a leading "." (hidden/special files),
 *  - a trailing "." (Windows silently strips it, so "a." would alias "a"),
 *  - keys longer than 128 characters.
 */
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const MAX_KEY_LENGTH = 128;

export function isSafeStorageKey(key: unknown): boolean {
  return (
    typeof key === "string" &&
    key.length <= MAX_KEY_LENGTH &&
    SAFE_KEY.test(key) &&
    !key.includes("..") &&
    !key.endsWith(".")
  );
}
