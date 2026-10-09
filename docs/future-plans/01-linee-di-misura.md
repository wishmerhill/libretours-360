# Linee di misura nelle scene 360°

> **Stato: implementato.** La documentazione aggiornata è in [docs/measurements.md](../measurements.md). Questo piano resta come traccia storica; rispetto a quanto scritto qui, l'implementazione:
> - trascina gli estremi nel punto esatto sotto il cursore (`viewerCoordsToSphericalCoords`), non con il calcolo approssimato degli hotspot;
> - mostra le misure anche in anteprima e nell'export standalone (cubemap), che le disegna su un livello SVG;
> - ha un pulsante "Misure" per mostrarle o nasconderle in editor, anteprima ed entrambi gli export.

## Context
L'utente vuole tracciare a mano linee di misura sui panorami (punto A → punto B, con un'etichetta digitata tipo "3,45 m"), visibili con un toggle, nell'editor e nell'export 3D (PSV).

Ogni linea appartiene a una scena e si guarda dallo stesso punto di ripresa. Quindi:
- gli estremi salvati come yaw/pitch restano esatti da qualunque direzione di vista, perché non c'è parallasse;
- una retta 3D vista dal centro di proiezione è un arco di cerchio massimo, quindi la disegniamo campionando la slerp tra A e B, e appare dritta e corretta da ogni angolazione e zoom.

Non serve nessuna ricostruzione 3D. La misura è un testo libero, perché le scene non hanno dati di scala.

## Modello dati
- In [src/types/tour.ts](src/types/tour.ts):
  - aggiungere `Measurement { id, a: {yaw, pitch}, b: {yaw, pitch}, label: string }` in gradi, come gli hotspot;
  - aggiungere `measurements: Measurement[]` a `Scene`;
  - aggiungere `showMeasurements: boolean` a `TourProject`, cioè il default di visibilità nel viewer esportato.
- In [src/lib/project-schema.ts](src/lib/project-schema.ts):
  - `measurementSchema`;
  - `sceneSchema.measurements: z.array(measurementSchema).default([])`;
  - `showMeasurements: z.boolean().default(true)`.
- Portare `CURRENT_SCHEMA_VERSION` a 2, con uno step in `migrateProject()` (L227) che inizializza i campi, come da convenzione.
- `uid("ms")` per gli id.

## Matematica condivisa
Nuovo modulo `src/lib/measure-geometry.ts`, puro e testabile:
- `toVec(yaw, pitch)` / `fromVec(v)`;
- `greatCirclePoints(a, b, n=32)`: campionamento slerp, restituisce `[yawRad, pitchRad][]` per il polyline di PSV;
- gestire il caso antipodale e il wrap di yaw a ±180;
- `midpoint(a, b)` per posizionare l'etichetta.

Nel viewer esportato serve la stessa logica come script inline: piccola funzione duplicata in JS puro nel template, con le backslash attente al template literal (vedi il fix precedente).

## Editor
**[src/routes/editor.$id.tsx](src/routes/editor.$id.tsx)**
- Nuovo stato:
  - `measuring: boolean`, un tool analogo a `placing` e mutuamente esclusivo con esso;
  - `showMeasurements: boolean`, solo vista editor, default true;
  - `selectedMeasurementId`.
- Pulsanti in toolbar accanto ad "Aggiungi hotspot" (L790):
  - "Misura", che attiva/disattiva il tool;
  - toggle visibilità (icona `Ruler` / `Eye` da lucide).
- Callback:
  - `addMeasurement(a, b)` crea la misura con label vuota, la seleziona e apre l'editing della label;
  - `moveMeasurementPoint(id, "a" | "b", pos)`;
  - `updateMeasurement`;
  - `deleteMeasurement`.
- Tutti passano da `update(draft => ...)`, così l'autosave funziona già.
- `setMode` (L908) resetta anche `measuring`.

**[src/components/studio/PanoCanvas.tsx](src/components/studio/PanoCanvas.tsx)**
- Nuove prop: `measuring`, `showMeasurements`, `selectedMeasurementId`, `onAddMeasurement`, `onMoveMeasurementPoint`, `onSelectMeasurement`, lette via ref come le altre.
- **Click handler (L209):** in modalità `measuring`:
  - il primo click fissa A e mostra un marker temporaneo;
  - il secondo click fissa B e chiama `onAddMeasurement`;
  - Esc annulla;
  - opzionale: durante l'attesa del secondo punto, una linea elastica che segue il mouse via evento `position-updated`/mousemove.
- **Rendering**, una funzione `syncMeasurementMarkers()` accanto alla sync degli hotspot (circa L344). Per ogni misura, se `showMeasurements`:
  - un marker `polyline` con `greatCirclePoints`, `svgStyle` con stroke contrastato (bianco con outline scuro, tratteggio opzionale) e larghezza maggiore se selezionata;
  - due marker HTML per gli estremi (pallini), trascinabili riusando la logica di drag degli hotspot (L430–520), che al rilascio chiamano `onMoveMeasurementPoint`. Durante il drag si aggiorna anche il polyline (`updateMarker`) in tempo reale;
  - un marker HTML con l'etichetta, posizionato a `midpoint`.
- Prefissi id marker `ms-<id>-line|a|b|label` per distinguerli in `click-marker` (L587) e selezionare la misura.
- Banner di aiuto stile `placeHotspotHint` (L743): "Clicca il primo punto" / "Clicca il secondo punto".
- Precisione degli estremi: lo zoom di PSV è già disponibile. Opzionale: una lente/mirino al cursore durante il tool.

**[src/components/studio/PropertiesPanel.tsx](src/components/studio/PropertiesPanel.tsx)**
- Quando è selezionata una misura:
  - campo label;
  - pulsante elimina;
  - eventualmente yaw/pitch numerici di A e B per la rifinitura fine.
- Nelle impostazioni progetto/tema: checkbox "Mostra misure nel tour esportato" (`project.showMeasurements`).

## Export 3D
**[src/lib/export.ts](src/lib/export.ts) `viewerHtml3D`**
- Includere `measurements: s.measurements` nel picking JSON (L37) e `showMeasurements`.
- In `updateMarkers(scene)` (L162):
  - aggiungere polyline e etichetta per ogni misura quando visibili;
  - nessun drag;
  - estremi come piccoli pallini.
- Aggiungere un pulsante toggle "📏" nell'UI del viewer, che nasconde/mostra i marker `ms-*` (`hideMarker` / `showMarker`). Stato iniziale da `showMeasurements`.
- Export cubemap: ignora il campo, fuori ambito.

## i18n
Chiavi nuove in [src/locales/en.json](src/locales/en.json) e [src/locales/it.json](src/locales/it.json):
- `editor.header.measure`, `editor.header.toggleMeasurements`;
- `editor.viewer.measureFirstPoint` / `measureSecondPoint`;
- `editor.properties.measurementLabel`, `deleteMeasurement`;
- `editor.toasts.*`.

Per le stringhe del viewer standalone valutare il dizionario già esistente (vedi memoria i18n).

## Verifica
- Test unitari per `measure-geometry.ts`:
  - gli estremi coincidono con A/B;
  - tutti i punti campionati giacciono sul piano (A, B, origine), cioè su un cerchio massimo;
  - wrap di yaw intorno a ±180;
  - vicinanza agli antipodi.
- Test per `migrateProject` v1→v2 e parse di un progetto vecchio senza `measurements`.
- Rieseguire il controllo con lo script `check.mjs`: valutare il template `viewerHtml3D`, fare il syntax check dello script e verificare che non ci siano regex o backslash rotte.
- Manuale in `npm run dev` / Tauri:
  - tracciare una linea su uno spigolo di una parete e ruotare/zoomare la vista: la linea deve restare sovrapposta allo spigolo;
  - trascinare gli estremi;
  - toggle;
  - ricaricare il progetto (persistenza);
  - esportare 3D e aprirlo in browser: linee, etichette e toggle funzionanti.
