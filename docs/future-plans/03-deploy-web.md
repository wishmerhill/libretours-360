# Deploy della versione web (Docker / Uniform Server)

## Context
Si vuole mettere in produzione la versione web dell'editor in due modi:
- **Docker**, per un server vero;
- **Uniform Server Zero XV** (Apache su Windows), per un uso semplice in locale o in LAN.

La versione web **non ha backend**: nessuna API e nessun database lato server. I progetti sono salvati nel browser (IndexedDB, `src/lib/web-storage.ts`). Il server deve solo servire file statici.

## Stima
| Opzione | Tempo indicativo | Contenuto |
|---|---|---|
| Docker | 1–2 h | Dockerfile multi-stage (Node build → nginx), `nginx.conf`, `docker-compose.yml` opzionale |
| Uniform Server | 30–60 min | build, copia in `www/`, `.htaccess` con fallback SPA |

Le stime vengono solo dalla lettura della configurazione: nessuna build o prova di deploy è stata ancora fatta.

## Punti da risolvere
1. **Dati nel browser, non sul server.**
   - I progetti vivono nel browser di ciascun utente: svuotando i dati del browser o cambiando PC si perdono, e non sono condivisi tra utenti.
   - Per uso serio:
     - usare l'app desktop Tauri;
     - oppure fare export/backup frequenti;
     - oppure, come progetto separato e più grande, un driver `StorageProvider` lato server.
2. **Fallback SPA.**
   - Le route dinamiche (`/editor/$id`) vanno riscritte su `index.html`, altrimenti il reload restituisce 404.
   - nginx: `try_files $uri $uri/ /index.html;`
   - Apache, in `.htaccess`:
     ```apache
     RewriteEngine On
     RewriteCond %{REQUEST_FILENAME} !-f
     RewriteCond %{REQUEST_FILENAME} !-d
     RewriteRule ^ index.html [L]
     ```
3. **`base: './'` in `vite.config.ts`.**
   - Con percorsi relativi, ricaricando `/editor/abc` il browser cerca `/editor/assets/...`; con il fallback riceve HTML al posto del JS e l'app si rompe.
   - Il `./` serve probabilmente per Tauri e per gli export. Per il web serve `base: '/'`, ad esempio:
     - un `vite.web.config.ts`;
     - oppure una variabile d'ambiente letta nel config;
     - oppure `<base href="/">` nell'HTML.
   - Va verificato il ricaricamento delle pagine dell'editor.
4. **Build target.**
   - `@lovable.dev/vite-tanstack-config` usa nitro con target Cloudflare di default, più il prerender di `/`.
   - Verificare quale output è il bundle statico corretto (l'attuale `dist/` contiene `index.html` + `assets/`).
   - Eventualmente impostare un preset nitro statico.
5. **HTTPS.**
   - Su Internet sempre dietro HTTPS: reverse proxy come Caddy o Traefik, oppure certificato su nginx.
   - In LAN va bene anche HTTP. Verificare che non servano API disponibili solo in contesto sicuro (es. `crypto.subtle`, che però funziona anche su `localhost`).
6. **Cache.**
   - `assets/*` hashati: `Cache-Control: immutable`.
   - `index.html`: `no-cache`.

## Sottopunto: affrancarsi da Lovable
Prerequisito consigliato per il deploy, perché risolve alla radice i punti 3 e 4.

### Cosa c'è oggi
- **`@lovable.dev/vite-tanstack-config`** (devDependency) è l'unico vincolo vero. `vite.config.ts` e `vite.tauri.config.ts` chiamano solo il suo `defineConfig`, che attiva in modo implicito questi plugin:
  - TanStack Start;
  - React e Tailwind;
  - tsconfig paths e alias `@`;
  - dedupe React/TanStack;
  - iniezione delle variabili `VITE_*`;
  - devtools;
  - error logger;
  - detection sandbox;
  - **nitro** con target Cloudflare di default.
- **`src/lib/lovable-error-reporting.ts`** (usato in `src/routes/__root.tsx`) inoltra gli errori all'editor Lovable. Fuori da Lovable è un no-op (`window.__lovableEvents?.`).
- **`src/server.ts`** è il wrapper SSR per gli errori h3/nitro. Non serve più se si elimina l'SSR.
- Il resto è standard: React, TanStack Router/Start, Vite, Photo Sphere Viewer, Tauri.

### Approccio
L'app non usa funzionalità server: niente server functions, niente API, storage in IndexedDB oppure filesystem Tauri. Due strade:

1. **TanStack Start in modalità SPA/statica.**
   - Si tiene il framework attuale e il `vite.config.ts` diventa esplicito: `tanstackStart({ spa: ... })`, `viteReact()`, `tailwindcss()`, alias.
   - Output statico `index.html` + `assets/`.
2. **Vite + TanStack Router puro, senza Start** (preferibile se fattibile).
   - È il setup più semplice ed elimina l'SSR, quindi anche il compromesso di idratazione con `lng:"en"` (vedi memoria i18n), `src/server.ts` e nitro.
   - Richiede `index.html` con entry `main.tsx` e il plugin `@tanstack/router-plugin` per il routing a file.

### Passi
1. Leggere `node_modules/@lovable.dev/vite-tanstack-config/dist` per elencare esattamente plugin e opzioni da replicare.
2. Scrivere `vite.config.ts` espliciti:
   - web con `base: '/'`;
   - Tauri e export con `base: './'` (già presente).
   - Rimuovere la dipendenza Lovable, `lovable-error-reporting.ts` e il suo uso in `__root.tsx`.
3. Se si sceglie l'opzione 2:
   - rimuovere `@tanstack/react-start`, `nitro` e `src/server.ts`;
   - adattare `__root.tsx` (shell HTML → `index.html`) e l'inizializzazione i18n.
4. Aggiornare gli script in `package.json`: `build`, `build:web`, `tauri:build`.

### Stima
Mezza giornata o una giornata, incluse le verifiche.

### Verifica
- `npm run build`: l'output è statico e servibile da nginx/Apache.
- `npm run tauri:build` e l'app desktop funzionano.
- `npm test` passa.
- L'export 3D e cubemap funziona.
- Il reload sulle route `/editor/$id` funziona.
- Il cambio lingua funziona senza flash.

## Bozza Docker
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build   # eventualmente con config web (base '/')

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html   # verificare la dir di output
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

## Verifica
- Fare la build web e servirla con nginx (Docker) e con Uniform Server.
- Aprire `/`, creare un progetto, entrare nell'editor e **ricaricare la pagina sull'URL dell'editor**.
- Caricare panorami, testare l'export 3D/cubemap e controllare che il progetto persista dopo il reload.
- Controllare la console: nessun 404 su assets o chunk.
