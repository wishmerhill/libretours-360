// Lets `node --test` run the project's TypeScript sources as they are:
// Node strips the types itself, this hook resolves what the bundler normally
// resolves (extensionless relative imports and the "@/" alias for src/).
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

function withExtension(base) {
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate) && /\.ts$/.test(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const url = withExtension(resolvePath(srcDir, specifier.slice(2)));
      if (url) return nextResolve(url, context);
    } else if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      const url = withExtension(base);
      if (url) return nextResolve(url, context);
    }
    return nextResolve(specifier, context);
  },
});
