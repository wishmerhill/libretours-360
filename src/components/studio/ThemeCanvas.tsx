import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Laptop, Maximize2, Smartphone, Tablet as TabletIcon } from "lucide-react";
import type { Theme } from "@/types/tour";
import { cn } from "@/lib/utils";
import {
  THEME_CANVAS_BREAKPOINTS,
  computeFitScale,
  themeCanvasBreakpoint,
  type ThemeCanvasBreakpointId,
} from "@/lib/theme-overlay-layout";
import { ThemeOverlayCanvas } from "./ThemeOverlayCanvas";

interface Props {
  projectId: string;
  projectName: string;
  sceneName: string | null;
  theme: Theme;
  logoPreviewUrl: string;
}

const BREAKPOINT_ICONS: Record<ThemeCanvasBreakpointId, typeof Laptop> = {
  desktop: Laptop,
  tablet: TabletIcon,
  mobile: Smartphone,
};

export function ThemeCanvas({ projectId, projectName, sceneName, theme, logoPreviewUrl }: Props) {
  const { t } = useTranslation();
  const [breakpointId, setBreakpointId] = useState<ThemeCanvasBreakpointId>("desktop");
  const [fitToScreen, setFitToScreen] = useState(true);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setContainerSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const breakpoint = themeCanvasBreakpoint(breakpointId);
  const scale = fitToScreen ? computeFitScale(breakpoint, containerSize) : 1;
  const measured = containerSize.width > 0 && containerSize.height > 0;

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center justify-center gap-1 border-b border-border bg-card/90 px-3 py-2 backdrop-blur">
        {THEME_CANVAS_BREAKPOINTS.map((bp) => {
          const Icon = BREAKPOINT_ICONS[bp.id];
          return (
            <button
              key={bp.id}
              type="button"
              onClick={() => setBreakpointId(bp.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                breakpointId === bp.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-panel hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(`editor.theme.canvas.${bp.id}`)}
            </button>
          );
        })}
        <div className="mx-2 h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => setFitToScreen((v) => !v)}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
            fitToScreen
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-panel hover:text-foreground",
          )}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {fitToScreen ? t("editor.theme.canvas.fitToScreen") : t("editor.theme.canvas.actualSize")}
        </button>
      </div>

      <div ref={containerRef} className="relative flex-1 overflow-auto p-8">
        {measured && (
          <div
            className="relative mx-auto"
            style={{ width: breakpoint.width * scale, height: breakpoint.height * scale }}
          >
            <div
              className="absolute left-0 top-0 origin-top-left overflow-hidden rounded-lg border border-border bg-muted shadow-xl"
              style={{
                width: breakpoint.width,
                height: breakpoint.height,
                transform: `scale(${scale})`,
              }}
            >
              <ThemeOverlayCanvas
                projectId={projectId}
                projectName={projectName}
                sceneName={sceneName}
                theme={theme}
                logoPreviewUrl={logoPreviewUrl}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
