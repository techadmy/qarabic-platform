/**
 * Preloaded into the API under a QA journey (`node --import`): any outbound request to a host
 * other than this machine fails, so a journey can never reach Zoom, WhatsApp, a payment provider
 * or mail, whatever the code under test tries. Blocked calls are logged on stderr.
 */
import http from 'node:http';
import https from 'node:https';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function refuse(target) {
  const message = `[qa no-egress] blocked an outbound request to ${target}`;
  console.error(message);
  return new Error(message);
}

function hostOf(input) {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === 'object') {
      if ('url' in input && typeof input.url === 'string') return new URL(input.url).hostname;
      return input.hostname ?? input.host ?? 'localhost';
    }
  } catch {
    return String(input);
  }
  return 'localhost';
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const host = hostOf(input);
  if (!LOCAL.has(host)) throw refuse(host);
  return realFetch(input, init);
};

for (const mod of [http, https]) {
  for (const name of ['request', 'get']) {
    const real = mod[name];
    mod[name] = function guarded(...args) {
      const host = hostOf(args[0]).replace(/:\d+$/, '');
      if (!LOCAL.has(host)) throw refuse(host);
      return real.apply(this, args);
    };
  }
}
