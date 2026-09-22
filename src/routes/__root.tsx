import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { subscribeStorageIssues } from "../lib/storage-errors";
import i18n, { applyDetectedLanguage } from "@/lib/i18n";

/** Shows storage problems (corrupted/restored projects, ...) as toasts. */
function StorageIssueToasts() {
  useEffect(
    () =>
      subscribeStorageIssues((issue) => {
        const show = issue.level === "error" ? toast.error : toast.warning;
        show(issue.title, { id: issue.id, description: issue.description, duration: 12000 });
      }),
    [],
  );
  return null;
}

function NotFoundComponent() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">{t("app.notFound.code")}</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">{t("app.notFound.heading")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("app.notFound.hint")}</p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("app.notFound.goHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const { t } = useTranslation();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("app.error.heading")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("app.error.hint")}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("app.error.tryAgain")}
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            {t("app.error.goHome")}
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "LibreTours 360 - Studio" },
      {
        name: "description",
        content: "Local-first 360° virtual tour creator and editor in your browser.",
      },
      { name: "author", content: "LibreTours 360" },
      { property: "og:title", content: "LibreTours 360 - Studio" },
      {
        property: "og:description",
        content: "Local-first 360° virtual tour creator and editor in your browser.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: "@Lovable" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Both SSR and the first client render always use English (see lib/i18n.ts), so the
  // hydrated tree matches the server exactly; the real language is applied right after,
  // as an ordinary post-mount update. <html lang> then tracks it going forward.
  useEffect(() => {
    const applyLang = () => {
      document.documentElement.lang = i18n.language;
    };
    applyLang();
    i18n.on("languageChanged", applyLang);
    // React can still be selectively hydrating other subtrees (e.g. inside portals)
    // when this effect fires; switching the language mid-hydration would diff against
    // markup React hasn't reconciled yet. A macrotask defers it until hydration settles.
    const timer = setTimeout(applyDetectedLanguage, 0);
    return () => {
      clearTimeout(timer);
      i18n.off("languageChanged", applyLang);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster theme="dark" />
      {/* After <Toaster/> so that issues buffered at start-up have somewhere to render. */}
      <StorageIssueToasts />
    </QueryClientProvider>
  );
}
