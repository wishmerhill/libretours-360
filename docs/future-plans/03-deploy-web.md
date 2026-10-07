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
