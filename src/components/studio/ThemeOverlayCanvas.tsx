import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { Theme } from "@/types/tour";
import { resolveThemeAssetUrl } from "@/lib/theme-assets";
import { cn } from "@/lib/utils";
import {
  overlayAnchorStyle,
  overlayElementStyle,
  resolveOverlayVariables,
} from "@/lib/theme-overlay-layout";

interface Props {
  projectId: string;
  projectName: string;
  sceneName: string | null;
  theme: Theme;
  /** Resolved, displayable URL of theme.logoUrl (see editor.$id.tsx), reused to avoid resolving it twice. */
  logoPreviewUrl: string;
  /** Id of the overlay element currently selected in the sidebar/inspector, if any. */
  selectedElementId?: string | null | undefined;
  /** A custom overlay element (not the built-in navbar/title) was clicked. */
  onSelectElement?: ((id: string) => void) | undefined;
}

/**
 * Renders the theme's built-in overlays (logo/navbar, title) and its
 * `overlays` elements on top of whatever fills the parent (a responsive
 * frame in the Theme Canvas, or the exported viewer). Purely presentational:
 * layout math lives in lib/theme-overlay-layout.ts so it can be unit tested.
 */
export function ThemeOverlayCanvas({
  projectId,
  projectName,
  sceneName,
  theme,
  logoPreviewUrl,
  selectedElementId = null,
  onSelectElement,
}: Props) {
  const imageRefsKey = theme.overlays
    .filter((el) => el.type !== "text" && el.content)
    .map((el) => el.content)
    .join("|");
  const [overlayUrls, setOverlayUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!imageRefsKey) {
      setOverlayUrls({});
      return;
    }
    let active = true;
    (async () => {
      const entries: Record<string, string> = {};
      for (const ref of imageRefsKey.split("|")) {
        entries[ref] = await resolveThemeAssetUrl(projectId, ref);
      }
      if (active) setOverlayUrls(entries);
    })();
    return () => {
      active = false;
    };
  }, [projectId, imageRefsKey]);

  const navbarVisible = theme.showNavbar && !!logoPreviewUrl;
  const variables: Record<string, string> = {
    "scene.title": sceneName ?? "",
    "project.name": projectName,
  };

  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden">
      {navbarVisible && (
        <div className="absolute left-4 top-4 flex items-center rounded-lg border border-border bg-card/85 px-3 py-2 backdrop-blur">
          <img src={logoPreviewUrl} alt="" className="h-8 max-w-[160px] object-contain" />
        </div>
      )}
      {theme.showTitleOverlay && (
        <div
          className={cn(
            "absolute left-4 rounded-lg border border-border bg-card/85 px-3 py-2 backdrop-blur",
            navbarVisible ? "top-[72px]" : "top-4",
          )}
        >
          <p className="text-xs font-semibold">{projectName}</p>
          {sceneName && <p className="text-[11px] text-muted-foreground">{sceneName}</p>}
        </div>
      )}
      {theme.overlays.map((el) => {
        const style = { ...overlayAnchorStyle(el), ...overlayElementStyle(el.style) };
        const selected = el.id === selectedElementId;
        const selectable = cn(
          "pointer-events-auto cursor-pointer",
          selected && "outline outline-2 outline-offset-2 outline-primary",
        );
        const handleClick = onSelectElement
          ? (e: React.MouseEvent) => {
              e.stopPropagation();
              onSelectElement(el.id);
            }
          : undefined;
        if (el.type === "text") {
          return (
            <div
              key={el.id}
              style={style}
              onClick={handleClick}
              className={cn("whitespace-pre-wrap text-sm text-foreground", selectable)}
            >
              {resolveOverlayVariables(el.content, variables)}
            </div>
          );
        }
        const src = el.content ? overlayUrls[el.content] : "";
        return (
          <div
            key={el.id}
            style={{
              minWidth: style.width ? undefined : 64,
              minHeight: style.height ? undefined : 64,
              ...style,
            }}
            onClick={handleClick}
            className={cn(
              "flex items-center justify-center overflow-hidden",
              !src &&
                "rounded-md border border-dashed border-border bg-panel/60 text-muted-foreground",
              selectable,
            )}
          >
            {src ? (
              <img src={src} alt="" className="h-full w-full object-contain" />
            ) : (
              <ImageIcon className="h-5 w-5" />
            )}
          </div>
        );
      })}
    </div>
  );
}
