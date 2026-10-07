# Traduzioni degli export Web 3D e Offline 2D

## Context
Editor, dashboard e viewer standalone cubemap sono già pronti per i18n/l10n:
- l'editor e la dashboard usano i18next con i dizionari in `src/locales/`;
- il viewer cubemap ha un dizionario EN/IT proprio dentro `src/lib/cubemap/viewer/viewer.js`.

I due template in `src/lib/export.ts` invece **non sono localizzati**: `viewerHtml3D` (Web 3D, Photo Sphere Viewer) e `viewerHtml2D` (Offline 2D). Il README lo dichiara come limite noto. Obiettivo: il tour esportato si presenta nella lingua giusta e il meccanismo è estendibile a nuove lingue come il resto dell'app.

## Stato attuale
Le stringhe sono poche, ma sparse:
- **`<html lang="it">` fisso** in entrambi i template (`export.ts` circa L43 e L253), anche quando il tour è in inglese.
- **Web 3D:**
  - fallback `"Info"` come titolo del popup degli hotspot info senza tooltip (circa L159);
  - pulsante di chiusura del modal (`&times;`) senza `aria-label`;
  - `alert(hs.tooltip)` per gli hotspot senza contenuto.
- **Offline 2D:**
  - etichette degli hotspot costruite con prefissi testuali `"i "`, `"-> "`, `"[] "` e fallback `h.type` (circa L316), quindi a schermo compare il nome tecnico del tipo (`door`, `arrow`) se manca il tooltip.
- **Testi futuri:** i piani 01 (pulsante misure) e 02 (minimappa, selettore piano) aggiungeranno altre stringhe a questi viewer. Conviene avere il meccanismo pronto prima.

Il contenuto del tour (nomi scene, tooltip, testi markdown) è scritto dall'utente e **non** si traduce: si localizza solo l'interfaccia del viewer.

## Approccio
1. **Dizionario condiviso dei viewer esportati.**
   - Estrarre le stringhe del viewer cubemap (`STRINGS` in `viewer.js`) in un modulo unico, es. `src/lib/viewer-strings.ts`, con le chiavi usate da tutti e tre i viewer esportati (`info`, `close`, `scenes`, `fullscreen`, …).
   - Il modulo esporta l'oggetto e una piccola funzione `t(key)` serializzabile.
   - I tre export iniettano lo stesso dizionario: niente i18next, i viewer devono restare senza dipendenze.
2. **Scelta della lingua del tour.** Due opzioni, entrambe semplici:
   - **(consigliata)** lingua del visitatore dal `navigator.language`, come fa già il cubemap, con fallback a una lingua scelta dall'autore;
   - in più, campo `project.language` (es. `"auto" | "en" | "it"`) nelle impostazioni del progetto o nel dialog di export, per forzarla. Se si aggiunge il campo: schema Zod con default `"auto"` e coordinare il bump di versione con i piani 01/02.
3. **Template.**
   - `<html lang>` impostato a runtime (`document.documentElement.lang = LANG`, come nel cubemap) oppure alla lingua forzata;
   - sostituire `"Info"`, i prefissi testuali del 2D e il fallback `h.type` con stringhe del dizionario (o icone);
   - aggiungere `aria-label` tradotti ai pulsanti.
4. **Detection estendibile.** Sostituire la regex fissa `/^it\b/` del cubemap con una ricerca della lingua tra le chiavi del dizionario (`navigator.languages` → prima lingua disponibile → `en`), così aggiungere una lingua significa solo aggiungere una voce al dizionario.
5. **README.** Aggiornare la sezione i18n ("Adding a language": un solo dizionario per i viewer esportati) e togliere il limite noto.

## Da sistemare insieme (stesso codice)
- **`project.name` inserito nell'HTML senza escape** (`<title>` e `#title` in entrambi i template). Un nome con `<` o `&` rompe la pagina. Usare un `escapeHtml()`.
- **JSON delle scene dentro `<script>`** (`var SCENES = ${scenesJson}`). Una stringa contenente `</script>` chiude lo script. Fare l'escape di `<` come `<` nella serializzazione.

## File coinvolti
- `src/lib/export.ts` (`viewerHtml3D`, `viewerHtml2D`)
- `src/lib/cubemap/viewer/viewer.js` e `src/lib/cubemap/build-html.ts` (iniezione del dizionario)
- nuovo `src/lib/viewer-strings.ts`
- eventualmente `src/types/tour.ts` e `src/lib/project-schema.ts` per `project.language`
- `README.md`

Attenzione: i template sono template literal; ogni regex o backslash nel codice iniettato va raddoppiato (vedi il fix `34063ba`). Meglio iniettare il dizionario con `JSON.stringify`.

## Stima
Mezza giornata, verifiche incluse.

## Verifica
- Test unitari:
  - il dizionario ha le stesse chiavi per ogni lingua;
  - la selezione della lingua (`it-IT` → `it`, `de` → `en`, lingua forzata);
  - l'escape di `project.name` e del JSON (`</script>`, `<`, `&`).
- Syntax check degli script generati (stile `check.mjs`).
- Manuale: esportare Web 3D, Offline 2D e cubemap e aprirli con il browser in italiano e in inglese:
  - `lang`, popup info, etichette ed `aria-label` nella lingua giusta;
  - un progetto con nome `A & B <test>` si visualizza correttamente.
