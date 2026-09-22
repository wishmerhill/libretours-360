import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ReverseHotspotModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** URL dell'immagine equirettangolare della scena di destinazione */
  targetImageUrl: string;
  /** Nome della scena di destinazione (per il titolo) */
  targetSceneName: string;
  /** Callback con le coordinate pitch/yaw (gradi) del punto cliccato */
  onConfirm: (pitch: number, yaw: number) => void;
}

export function ReverseHotspotModal({
  open,
  onOpenChange,
  targetImageUrl,
  targetSceneName,
  onConfirm,
}: ReverseHotspotModalProps) {
  const { t } = useTranslation();
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinPos, setPinPos] = useState<{ x: number; y: number } | null>(null);
  const [coords, setCoords] = useState<{ pitch: number; yaw: number } | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  // Resetta lo stato quando si apre la modale
  useEffect(() => {
    if (open) {
      setPinPos(null);
      setCoords(null);
      setImgLoaded(false);
    }
  }, [open]);

  const handleImageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!imgRef.current || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Coordinate relative (0..1)
    const relX = clickX / rect.width;
    const relY = clickY / rect.height;

    // Conversione in coordinate sferiche (gradi)
    // yaw: 0 = centro immagine (nord), -180..180
    // pitch: 0 = equatore, -90 (giù) .. 90 (su)
    const yaw = relX * 360 - 180;
    const pitch = 90 - relY * 180;

    setPinPos({ x: clickX, y: clickY });
    setCoords({ pitch: Number(pitch.toFixed(2)), yaw: Number(yaw.toFixed(2)) });
  }, []);

  const handleConfirm = () => {
    if (coords) {
      onConfirm(coords.pitch, coords.yaw);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("dialogs.reverseHotspot.title")}</DialogTitle>
          <DialogDescription>
            {t("dialogs.reverseHotspot.description", { sceneName: targetSceneName })}
          </DialogDescription>
        </DialogHeader>

        <div
          ref={containerRef}
          className="relative cursor-crosshair overflow-hidden rounded-lg border border-border bg-muted"
          style={{ aspectRatio: "2 / 1", maxHeight: "50vh" }}
          onClick={handleImageClick}
        >
          <img
            ref={imgRef}
            src={targetImageUrl}
            alt={t("dialogs.reverseHotspot.targetAlt")}
            className="h-full w-full object-contain"
            onLoad={() => setImgLoaded(true)}
            draggable={false}
          />

          {!imgLoaded && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              {t("dialogs.reverseHotspot.loading")}
            </div>
          )}

          {/* Linea dell'equatore (pitch = 0) */}
          {imgLoaded && (
            <>
              <div
                className="absolute left-0 right-0 border-b border-dashed border-white/40 pointer-events-none"
                style={{ top: "50%" }}
              />
              <div
                className="absolute left-2 text-[10px] text-white/50 pointer-events-none"
                style={{ top: "calc(50% + 2px)" }}
              >
                {t("dialogs.reverseHotspot.equator")}
              </div>
            </>
          )}

          {/* Mirino / pin di anteprima */}
          {pinPos && (
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: pinPos.x, top: pinPos.y }}
            >
              <div className="relative flex items-center justify-center">
                {/* Anello esterno pulsante */}
                <div className="absolute h-8 w-8 animate-ping rounded-full bg-primary/40" />
                {/* Cerchio interno */}
                <div className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-primary shadow-lg">
                  <Crosshair className="h-3.5 w-3.5 text-white" />
                </div>
              </div>
            </div>
          )}

          {!pinPos && imgLoaded && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white">
              {t("dialogs.reverseHotspot.clickHint")}
            </div>
          )}
        </div>

        {coords && (
          <div className="text-center text-xs text-muted-foreground">
            {t("dialogs.reverseHotspot.position", { pitch: coords.pitch, yaw: coords.yaw })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("dialogs.reverseHotspot.cancel")}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={!coords}>
            <Check className="mr-1.5 h-3.5 w-3.5" /> {t("dialogs.reverseHotspot.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
