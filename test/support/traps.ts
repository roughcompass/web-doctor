import child_process from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import module from "node:module";
import net from "node:net";
import tls from "node:tls";
import vm from "node:vm";
import worker_threads from "node:worker_threads";

/**
 * Replaces every way to reach the network, start a process or worker, load
 * code, or evaluate code with a trap that records the attempt and throws.
 * Code under test that needs none of these runs unchanged.
 */
export interface InstalledTraps {
  attempts: string[];
  restore: () => void;
}

type Owner = Record<string, unknown>;

export function installTraps(): InstalledTraps {
  const attempts: string[] = [];
  const restores: (() => void)[] = [];
  const trap = (owner: object, name: string, label: string) => {
    const target = owner as Owner;
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function trapped() {
      attempts.push(label);
      throw new Error(`trap: ${label} was attempted`);
    };
    restores.push(() => {
      target[name] = original;
    });
  };

  for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolvePtr", "resolveSrv", "resolveTxt", "reverse"]) {
    trap(dns, name, `dns.${name}`);
    trap(dns.promises, name, `dns.promises.${name}`);
  }
  trap(net, "connect", "net.connect");
  trap(net, "createConnection", "net.createConnection");
  trap(net.Socket.prototype, "connect", "net.Socket.connect");
  trap(tls, "connect", "tls.connect");
  for (const name of ["request", "get"]) {
    trap(http, name, `http.${name}`);
    trap(https, name, `https.${name}`);
  }
  trap(globalThis, "fetch", "fetch");
  trap(globalThis, "WebSocket", "WebSocket");
  trap(globalThis, "EventSource", "EventSource");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) trap(child_process, name, `child_process.${name}`);
  trap(worker_threads, "Worker", "worker_threads.Worker");
  trap(process, "dlopen", "process.dlopen");
  for (const name of ["Script", "runInThisContext", "runInNewContext", "runInContext", "compileFunction"]) trap(vm, name, `vm.${name}`);
  trap(globalThis, "eval", "eval");
  trap(module, "_load", "module._load");
  trap(module, "createRequire", "module.createRequire");
  // ESM named imports of built-ins see the trapped functions only after syncing.
  module.syncBuiltinESMExports();
  return {
    attempts,
    restore: () => {
      for (const restore of restores.reverse()) restore();
      module.syncBuiltinESMExports();
    },
  };
}

/** Runs +action+ with every trap installed and returns its result and any attempts. */
export async function withTraps<Result>(action: () => Promise<Result>): Promise<{ result: Result; attempts: string[] }> {
  const traps = installTraps();
  try {
    return { result: await action(), attempts: traps.attempts };
  } finally {
    traps.restore();
  }
}
