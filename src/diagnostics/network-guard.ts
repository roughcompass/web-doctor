import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import module from "node:module";
import net from "node:net";
import process from "node:process";
import tls from "node:tls";

/**
 * Preloaded into provider workers that were not granted network access.
 * Every way to open a connection or resolve a name throws and is recorded,
 * so a provider that swallows the error is still reported as having
 * attempted undeclared network access.
 */

const denied: string[] = ((globalThis as { __webDoctorDenied?: string[] }).__webDoctorDenied ??= []);

class NetworkDenied extends Error {
  readonly code = "ERR_WEB_DOCTOR_NETWORK_DENIED";
  readonly permission = "Network";

  constructor(readonly resource: string) {
    super(`Network access is not granted to this provider (${resource})`);
  }
}

// A program that is not a Web Doctor task reports each refusal on stderr, so a swallowed refusal is still seen.
const report = process.env.WEB_DOCTOR_DENIAL_LOG === "stderr";

function block(owner: object, name: string, label: string): void {
  const target = owner as Record<string, unknown>;
  if (typeof target[name] !== "function") return;
  target[name] = function blocked() {
    denied.push("network");
    if (report) process.stderr.write(`web-doctor-denied: network ${label}\n`);
    throw new NetworkDenied(label);
  };
}

for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolvePtr", "resolveSrv", "resolveTxt", "reverse"]) {
  block(dns, name, `dns.${name}`);
  block(dns.promises, name, `dns.promises.${name}`);
}
block(net, "connect", "net.connect");
block(net, "createConnection", "net.createConnection");
block(net.Socket.prototype, "connect", "net.Socket.connect");
block(tls, "connect", "tls.connect");
for (const name of ["request", "get"]) {
  block(http, name, `http.${name}`);
  block(https, name, `https.${name}`);
}
block(globalThis, "fetch", "fetch");
block(globalThis, "WebSocket", "WebSocket");
block(globalThis, "EventSource", "EventSource");
module.syncBuiltinESMExports();
