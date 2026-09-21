/**
 * Where a cubemap export is written.
 *
 *  - Tauri: the user picks a parent folder with the native dialog (which also
 *    grants the fs plugin access to it) and the tour is written into a new
 *    sub-folder with `@tauri-apps/plugin-fs`. Nothing is downloaded through the DOM.
 *  - Browser (no native file access): a zip download, as the other exports do.
 */
import { isTauri } from "../environment";
import { classifyFsError } from "../storage-errors";
import type { ExportSink } from "./export";

export interface OpenedSink extends ExportSink {
  /** Human-readable destination, for the confirmation message. */
  location: string;
  /** Absolute path of index.html on disk (Tauri only). */
  indexPath?: string;
  /** Call after the last file has been written. */
  finish(): Promise<void>;
}

/**
 * Asks the user where to export. Resolves to null when the dialog is cancelled.
 * `folderName` is the name of the sub-folder created inside the chosen folder.
 */
export async function openExportSink(folderName: string): Promise<OpenedSink | null> {
  return isTauri() ? await openTauriFolderSink(folderName) : openZipSink(folderName);
}

async function openTauriFolderSink(folderName: string): Promise<OpenedSink | null> {
  const [{ open }, fs, path] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);

  const parent = await open({
    title: "Choose where to create the tour folder",
    directory: true,
    multiple: false,
    // Grants the fs plugin write access to the chosen folder and everything under it.
    recursive: true,
    canCreateDirectories: true,
  });
  if (!parent || Array.isArray(parent)) return null;

  try {
    // Never write into (or over) an existing folder: pick a free name.
    let root = await path.join(parent, folderName);
    for (let n = 2; await fs.exists(root); n++)
      root = await path.join(parent, `${folderName}-${n}`);
    await fs.mkdir(root, { recursive: true });

    const made = new Set<string>();
    return {
      location: root,
      indexPath: await path.join(root, "index.html"),
      async writeFile(relPath, data) {
        const segments = relPath.split("/");
        const dir = await path.join(root, ...segments.slice(0, -1));
        const target = await path.join(dir, segments[segments.length - 1]!);
        try {
          if (!made.has(dir)) {
            await fs.mkdir(dir, { recursive: true });
            made.add(dir);
          }
          if (typeof data === "string") await fs.writeTextFile(target, data);
          else await fs.writeFile(target, data);
        } catch (e) {
          throw classifyFsError(e, target);
        }
      },
      async finish() {},
    };
  } catch (e) {
    throw classifyFsError(e, parent);
  }
}

async function openZipSink(folderName: string): Promise<OpenedSink> {
  const [{ default: JSZip }, { default: saveAs }] = await Promise.all([
    import("jszip"),
    import("file-saver"),
  ]);
  const zip = new JSZip();
  return {
    location: `${folderName}.zip`,
    async writeFile(relPath, data) {
      // JPEGs are already compressed: storing them is faster and not larger.
      zip.file(relPath, data, { compression: relPath.endsWith(".jpg") ? "STORE" : "DEFLATE" });
    },
    async finish() {
      saveAs(await zip.generateAsync({ type: "blob" }), `${folderName}.zip`);
    },
  };
}
