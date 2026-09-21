/* eslint-disable @typescript-eslint/no-explicit-any -- DevTools Protocol payloads are untyped JSON */
/**
 * A tiny Chrome DevTools Protocol driver (no dependencies): launches headless
 * Chrome, opens a page, evaluates code, takes screenshots and sends input.
 * Only used by the end-to-end test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, type DecodedPng } from "./png";

export function findChrome(): string | null {
  const candidates = [
    process.env["CHROME_PATH"],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export interface PageDriver {
  /** Console errors, uncaught exceptions and failed requests seen so far. */
  problems: string[];
  goto(url: string): Promise<void>;
  eval<T = unknown>(expression: string): Promise<T>;
  /** Waits until `expression` is truthy (polling), or throws after `timeoutMs`. */
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  screenshot(): Promise<DecodedPng>;
  mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number): Promise<void>;
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  key(key: string): Promise<void>;
  close(): Promise<void>;
}

export async function launchPage(
  chromePath: string,
  options: { width: number; height: number; args?: string[] },
): Promise<PageDriver> {
  const userData = mkdtempSync(join(tmpdir(), "cubemap-e2e-"));
  const child: ChildProcess = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userData}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      ...(options.args ?? []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const cleanup = () => {
    child.kill();
    rmSync(userData, { recursive: true, force: true });
  };

  try {
    // Chrome writes its debugging port to a file in the profile folder.
    const portFile = join(userData, "DevToolsActivePort");
    for (let i = 0; !existsSync(portFile); i++) {
      if (i > 100) throw new Error("Chrome did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 100));
    const [port, browserPath] = readFileSync(portFile, "utf8").trim().split("\n");

    const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Cannot connect to Chrome DevTools"));
    });

    let nextId = 1;
    const pending = new Map<number, Pending>();
    const listeners: ((method: string, params: any) => void)[] = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) p?.reject(new Error(`${message.error.message}`));
        else p?.resolve(message.result);
      } else {
        for (const l of listeners) l(message.method, message.params);
      }
    };
    const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      });

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method: string, params: object = {}) => send(method, params, sessionId);

    const problems: string[] = [];
    listeners.push((method, params) => {
      if (method === "Runtime.exceptionThrown") {
        problems.push(
          `exception: ${params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text}`,
        );
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        problems.push(
          `console.error: ${params.args?.map((a: any) => a.value ?? a.description).join(" ")}`,
        );
      } else if (method === "Network.loadingFailed" && !params.canceled) {
        problems.push(`request failed: ${params.errorText} (${params.type})`);
      } else if (method === "Log.entryAdded" && params.entry.level === "error") {
        problems.push(`log: ${params.entry.text} ${params.entry.url ?? ""}`);
      }
    });

    await Promise.all([
      call("Page.enable"),
      call("Runtime.enable"),
      call("Network.enable"),
      call("Log.enable"),
    ]);
    await call("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const driver: PageDriver = {
      problems,
      async goto(url) {
        const loaded = new Promise<void>((resolve) => {
          const l = (method: string) => {
            if (method === "Page.loadEventFired") {
              listeners.splice(listeners.indexOf(l), 1);
              resolve();
            }
          };
          listeners.push(l);
        });
        await call("Page.navigate", { url });
        await loaded;
      },
      async eval<T>(expression: string) {
        const { result, exceptionDetails } = await call("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (exceptionDetails)
          throw new Error(
            `eval failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
          );
        return result.value as T;
      },
      async waitFor(expression, timeoutMs = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (await driver.eval<boolean>(`!!(${expression})`)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`Timed out waiting for: ${expression}`);
      },
      async screenshot() {
        // Let a frame render before capturing.
        await driver.eval(
          "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
        );
        const { data } = await call("Page.captureScreenshot", { format: "png" });
        return decodePng(Buffer.from(data, "base64"));
      },
      async mouse(type, x, y) {
        await call("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: type === "mouseMoved" ? "none" : "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
      },
      async wheel(x, y, deltaY) {
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
      },
      async key(key) {
        await call("Input.dispatchKeyEvent", { type: "keyDown", key });
        await call("Input.dispatchKeyEvent", { type: "keyUp", key });
      },
      async close() {
        ws.close();
        cleanup();
      },
    };
    return driver;
  } catch (e) {
    cleanup();
    throw e;
  }
}
