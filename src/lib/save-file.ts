/**
 * Saves a single file chosen by the user.
 *
 *  - Tauri: the native "Save as" dialog (which also grants the fs plugin access
 *    to the chosen path), then a native write. A DOM download would land
 *    wherever the webview puts it, without telling the user.
 *  - Browser: a regular download.
 */
import { isTauri } from "./environment";
import { classifyFsError } from "./storage-errors";

export interface SaveFileFilter {
  /** Shown in the dialog's type menu, e.g. "LibreTours project". */
  name: string;
  /** Without the dot, e.g. ["ltproj"]. */
  extensions: string[];
}

/**
 * Resolves with where the file went (absolute path in Tauri, file name in the
 * browser), or null when the user cancelled the dialog.
 */
export async function saveFile(
  data: Blob,
  fileName: string,
  filter: SaveFileFilter,
): Promise<string | null> {
  if (!isTauri()) {
    const { default: saveAs } = await import("file-saver");
    saveAs(data, fileName);
    return fileName;
  }

  const [{ save }, fs] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const target = await save({ defaultPath: fileName, filters: [filter] });
  if (!target) return null;
  try {
    await fs.writeFile(target, new Uint8Array(await data.arrayBuffer()));
  } catch (e) {
    throw classifyFsError(e, target);
  }
  return target;
}
