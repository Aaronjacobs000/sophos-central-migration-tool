// Runs the real Express routers on a local port so tests can read exactly what
// the browser would. Requests go through node:http, because the tests replace
// globalThis.fetch with the fake Sophos.

import http from "node:http";
import { once } from "node:events";

export async function startHttp(mounts) {
  const express = (await import("express")).default;
  const { errorHandler } = await import("../../backend/dist/middleware/error-handler.js");
  const app = express();
  app.use(express.json());
  for (const router of mounts) app.use("/api", router);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  function call(method, path, body, contentType = "application/json") {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const req = http.request({ host: "127.0.0.1", port, path, method, headers: data ? { "Content-Type": contentType, "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, text, body: json });
        });
      });
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** The first `count` events of a server-sent event stream, then hang up. */
  function events(path, count = 1) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
        let text = "";
        const out = [];
        res.setEncoding("utf8");
        res.on("data", (c) => {
          text += c;
          let i;
          while ((i = text.indexOf("\n\n")) >= 0) {
            const block = text.slice(0, i);
            text = text.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            out.push({ event, raw: data, data: data ? JSON.parse(data) : null });
            if (out.length >= count) {
              req.destroy();
              resolve(out);
              return;
            }
          }
        });
        res.on("end", () => resolve(out));
      });
      req.on("error", (err) => (err.code === "ECONNRESET" ? null : reject(err)));
    });
  }

  return {
    get: (p) => call("GET", p),
    post: (p, body) => call("POST", p, body ?? {}),
    del: (p) => call("DELETE", p),
    /** A plain HTML form post, as another site could send. */
    form: (p, text) => call("POST", p, text, "application/x-www-form-urlencoded"),
    /** A text/plain post, which another site can also send without a preflight. */
    text: (p, text) => call("POST", p, text, "text/plain"),
    /** A post with no body and no content type. */
    bare: (p) => call("POST", p),
    events,
    close: () => new Promise((r) => server.close(r)),
  };
}
