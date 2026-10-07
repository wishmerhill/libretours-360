# Planimetrie multi-piano con posizione e direzione di vista

## Context
L'utente vuole caricare una o più planimetrie dell'area del tour, una per piano: interrato, seminterrato, terra, rialzato, primo, ecc. Per ogni scena 360° deve poter indicare sulla planimetria:
- **dove si trova**, con un segnaposto rotondo;
- **dove sta guardando**, con un arco/cono attorno al segnaposto che l'utente ruota per allinearlo alla foto.

Nel tour esportato (export 3D PSV e cubemap standalone) la planimetria compare come **minimappa interattiva**:
- piano corrente;
- segnaposto della scena attiva;
- cono che ruota in tempo reale con la vista;
- click su un altro segnaposto per navigare a quella scena;
- selettore piano.

Oggi esiste solo uno stub:
- tipo `Floorplan { id, name, imageUrl }` in [src/types/tour.ts:97](src/types/tour.ts#L97);
- schema in [src/lib/project-schema.ts:149](src/lib/project-schema.ts#L149);
- tab "Planimetrie" nella sidebar con pulsante disabilitato ("Presto disponibile") in [LeftSidebar.tsx:581](src/components/studio/LeftSidebar.tsx#L581).

Non esistono upload, visualizzazione, legame con le scene o export.

## Modello di direzione (il punto chiave)
Il panorama ha un suo yaw 0, il centro dell'immagine equirettangolare. La planimetria ha i suoi assi. Basta un solo numero per scena:

`floorplanHeading` = angolo sulla planimetria (gradi, 0 = verso l'alto, orario) che corrisponde a yaw 0 del panorama.

- **Calibrazione nell'editor:**
  - l'utente orienta la vista 360° verso un riferimento riconoscibile (una porta, una finestra);
  - poi ruota l'arco sulla planimetria finché punta allo stesso riferimento;
  - si salva `floorplanHeading = angoloArco − yawCorrente`.
- **Visualizzazione:** il cono punta a `floorplanHeading + yawCorrente`, quindi segue la vista in tempo reale sia nell'editor sia nel viewer esportato.
- **Ampiezza del cono:** ricavata dal FOV/zoom corrente (opzionale, altrimenti 90° fissi).

## Modello dati
In [src/types/tour.ts](src/types/tour.ts):
- `Floorplan { id; name; imageUrl; level: number; order?: number }`
  - `level`: -2 interrato, -1 seminterrato, 0 terra, 0.5 rialzato, 1 primo…; serve per l'ordinamento;
  - `name` è libero ("Piano rialzato").
- `Scene.floorplanPosition?: { floorplanId: string; x: number; y: number; heading: number }`
  - `x`/`y` sono normalizzati 0..1 rispetto all'immagine, quindi indipendenti dalla risoluzione;
  - una scena sta su al massimo un piano.
- `TourProject.showFloorplanMinimap: boolean`, default true.

In [src/lib/project-schema.ts](src/lib/project-schema.ts):
- estendere `floorplanSchema` con `level` (default 0);
- validare `imageUrl` con `isSafeAssetRef`, come per i panorami e il tema, perché oggi manca;
- aggiungere `floorplanPosition` opzionale a `sceneSchema` e `showFloorplanMinimap`;
- bump di `CURRENT_SCHEMA_VERSION` con uno step in `migrateProject()`.

Se nel frattempo si implementano le linee di misura (piano 01), coordinare il numero di versione.

[src/lib/storage.ts:239](src/lib/storage.ts#L239) `cloneWithNewIds`:
- rimappare `floorplanId` nelle scene;
- copiare gli asset immagine, così il progetto duplicato non punta agli asset dell'originale.

## Storage immagini
Riusare gli asset generici `asset:<key>` del tema in [src/lib/theme-assets.ts](src/lib/theme-assets.ts):
- `putThemeAsset`, `resolveThemeAssetUrl`, `deleteThemeAsset`, helper data URL;
- eventualmente generalizzarli o rinominarli in un modulo `project-assets.ts` condiviso.

Formati accettati: PNG/JPG/WebP/SVG. Il PDF resta escluso; l'utente può esportarlo in immagine.

## Editor
**Sidebar, tab Planimetrie ([LeftSidebar.tsx:581](src/components/studio/LeftSidebar.tsx#L581))**
- Sostituire il placeholder con una lista dei piani ordinata per `level`:
  - miniatura, nome, livello (Select con preset + valore libero);
  - rinomina, sostituisci immagine, elimina (alert-dialog che avvisa delle scene collegate).
- Pulsante "Aggiungi planimetria" con file input.
- Click su un piano: lo apre nel pannello planimetria.

**Nuovo componente `src/components/studio/FloorplanPanel.tsx`**
- Riquadro sovrapposto al PanoCanvas, ridimensionabile/ingrandibile, oppure pannello affiancato con `resizable`.
- Mostra il piano selezionato:
  - **SVG sopra `<img>`**, con coordinate normalizzate 0..1 e `viewBox` sulle dimensioni naturali;
  - pan/zoom semplice fatto a mano (wheel + drag), sul modello del drag in [ThemeOverlayCanvas.tsx](src/components/studio/ThemeOverlayCanvas.tsx); nessuna dipendenza nuova.
- **Segnaposti:**
  - un cerchio per ogni scena posizionata su quel piano;
  - quello della scena attiva è evidenziato;
  - click su un segnaposto = cambia scena attiva.
- **Posizionare la scena attiva:**
  - pulsante "Posiziona qui questa scena", poi click sulla planimetria;
  - oppure trascinare il segnaposto della scena attiva.
- **Direzione:**
  - attorno al segnaposto attivo, un arco esterno con maniglia;
  - trascinando la maniglia l'arco ruota (`atan2` dal centro);
  - al rilascio si salva `heading = angoloArco − yawCorrente`, con normalizzazione a 0..360;
  - pulsante "Reset direzione".
- Cono dei segnaposti: settore SVG (`path` con arco), angolo `heading + yaw`.

**[PanoCanvas.tsx](src/components/studio/PanoCanvas.tsx)**
- Aggiungere la prop `onViewChange?(yawDeg, fovDeg)`.
- Agganciare il listener PSV `position-updated` (e `zoom-updated` per il FOV) accanto a `click`/`zoom-updated` (circa L230–261), usando `addEventListener` come già fatto.
- Throttling con `requestAnimationFrame`.

**[editor.$id.tsx](src/routes/editor.$id.tsx)**
- Nuovo stato: `currentYaw`, solo vista e non persistito, alimentato da `onViewChange`.
- Nuovo stato: `selectedFloorplanId`, che segue il piano della scena attiva quando si cambia scena.
- Callback, tutti via `update(draft => ...)` con autosave esistente:
  - `addFloorplan`, `updateFloorplan`, `deleteFloorplan` (rimuove anche i `floorplanPosition` collegati);
  - `setScenePosition`, `setSceneHeading`.
- Toggle "Mostra planimetria" nella toolbar.

## Export: logica condivisa
Nuovo modulo `src/lib/floorplan-minimap.ts`, che esporta una **stringa JS** autonoma:
- vanilla, senza dipendenze, iniettata in entrambi i viewer;
- funzione `createMinimap(container, { floorplans, scenes, onNavigate })`;
- metodi `.setScene(id)`, `.setYaw(deg)`, `.setFov(deg)`;
- disegna SVG + img, gestisce il selettore piano e il click sui segnaposti.

Così la logica della minimappa esiste una volta sola per i due export. Attenzione alle backslash se finisce dentro template literal (vedi il bug regex corretto prima). Meglio un file `.js` importato come stringa raw (`?raw` di Vite), come già fa il cubemap con `viewer.js` se applicabile.

Testi del viewer: niente o pochi (nome piano). Usare il dizionario standalone esistente (vedi memoria i18n).

## Export 3D (PSV), [src/lib/export.ts](src/lib/export.ts)
- `buildZip` (L392):
  - risolvere le immagini dei piani come `resolvePanoramaForExport` (L374) in `floorplans/<slug>.<ext>`;
  - riscrivere `imageUrl` con il path relativo.
- `viewerHtml3D`:
  - includere `floorplans`, `floorplanPosition` delle scene e `showFloorplanMinimap` nel JSON (L37);
  - iniettare lo script minimappa;
  - collegare `viewer.addEventListener('position-updated')` a `minimap.setYaw`;
  - cambio scena a `minimap.setScene`;
  - `onNavigate` alla funzione di navigazione esistente.
- Pulsante per mostrare/nascondere la minimappa; su mobile parte chiusa.

## Export cubemap standalone
- In [src/lib/cubemap/export.ts](src/lib/cubemap/export.ts):
  - scrivere le immagini dei piani con `sink.writeFile("floorplans/…")`, come le facce;
  - le immagini vanno nei file e non come data URL, per non gonfiare `project.json`.
- In [src/lib/cubemap/build-html.ts](src/lib/cubemap/build-html.ts):
  - estendere `CubemapTour` e `buildTour` con `floorplans` e `floorplanPosition`;
  - incrementare la `version` del formato.
- In [src/lib/cubemap/viewer/viewer.js](src/lib/cubemap/viewer/viewer.js):
  - montare la minimappa;
  - chiamare `setYaw` dal loop di render (dove già ricalcola gli hotspot, circa L554);
  - `onNavigate` alla funzione di cambio scena.
- Verificare che le immagini funzionino da `file://`, perché `<img>` locali sono ok (vedi memoria cubemap).

## i18n
Chiavi in [src/locales/en.json](src/locales/en.json) / [it.json](src/locales/it.json) sotto `editor.sidebar.floorplans.*`:
- aggiornare `hint`;
- `add`, `rename`, `replace`, `delete`, `deleteConfirm`, `level`, preset dei livelli;
- `placeScene`, `resetHeading`, `notPlaced`.

Poi `editor.header.toggleFloorplan` e `editor.toasts.*`.

## Verifica
- Test unitari:
  - la matematica dell'heading (calibrazione → visualizzazione, wrap 0/360, yaw negativi);
  - lo schema e la migrazione (progetto vecchio senza `level`/`floorplanPosition`);
  - `cloneWithNewIds` con rimappatura;
  - `buildTour` con planimetrie;
  - estensione degli e2e del cubemap esistenti ([src/lib/cubemap/e2e.test.ts](src/lib/cubemap/e2e.test.ts)).
- Syntax check degli script generati (stile `check.mjs` usato per il fix regex).
- Manuale in `npm run dev` e Tauri:
  - caricare 2 piani;
  - posizionare 3 scene;
  - calibrare la direzione su una porta e ruotare la vista: il cono deve seguire coerentemente;
  - ricaricare (persistenza);
  - duplicare il progetto;
  - eliminare un piano con scene collegate.
- Export 3D aperto via server ed export cubemap aperto da `file://`:
  - minimappa visibile;
  - cono sincronizzato;
  - click su un segnaposto che naviga;
  - cambio piano;
  - comportamento su mobile.
