import { createServer, type Server } from "node:http";

/** A local test application for rendered checks: accessible, violating, ambiguous, stateful, and failing pages. */

const page = (body: string, title = "Orders") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;

export const PAGES: Readonly<Record<string, string>> = {
  "/accessible": page('<h1>Orders</h1><button type="button">Save</button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Company logo"><p style="color:#111;background:#fff">Three open orders</p>'),
  "/violating": page('<h1>Orders</h1><button type="button"></button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'),
  "/review": page('<h1>Orders</h1><div style="background-image:linear-gradient(#fff,#000);padding:8px"><span style="color:#777">Faded status text</span></div>'),
  "/stateful": page('<h1>Orders</h1><button id="open" type="button">Open menu</button><div id="menu"></div><script>document.getElementById("open").addEventListener("click", () => { document.getElementById("menu").innerHTML = "<button type=\\"button\\" class=\\"icon\\"></button>"; });</script>'),
};

/** The session cookie the authenticated /account page requires. */
export const ACCOUNT_SESSION = "fixture-session-7f3a";

export interface TestApp {
  origin: string;
  requests: string[];
  close: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === "/slow") return; // Never answers.
    if (url.pathname === "/account") {
      if (!(request.headers.cookie ?? "").split(/;\s*/).includes(`session=${ACCOUNT_SESSION}`)) {
        response.statusCode = 401;
        response.end("sign in");
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(page('<h1>Account</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><p>Signed in</p>', "Account"));
      return;
    }
    if (url.pathname === "/error") {
      response.statusCode = 500;
      response.end("failed");
      return;
    }
    const body = PAGES[url.pathname];
    if (body === undefined) {
      response.statusCode = 404;
      response.end("missing");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test application address is unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
