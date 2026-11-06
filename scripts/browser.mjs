// A Chrome DevTools connection for the page's browser checks: evaluate in the first page, send input, and collect
// what the page logs as an error or throws.

/** Connect to the Chrome listening on `port` (started with --remote-debugging-port). */
export async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error(`no page in the Chrome on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  let logged = [];
  const listeners = new Set();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) return pending.get(d.id)(d);
    for (const f of listeners) f(d);
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'assert'))
      logged.push(`console.${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    else if (d.method === 'Runtime.exceptionThrown') logged.push(`exception: ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`);
    else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && d.params.entry.source !== 'network') logged.push(`log: ${d.params.entry.text}`);
  };
  await new Promise((r) => (ws.onopen = r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  return {
    send,
    /** Evaluate `fn` (a function's source) in the page with `arg`, awaiting what it returns. */
    async call(fn, arg) {
      const r = await send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** What the page logged as an error or threw since the last call. */
    drain() {
      const out = logged;
      logged = [];
      return out;
    },
    /** Call `f` with each event Chrome sends; returns what stops it. */
    on(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    /** Open `url` fresh and wait for it to load. */
    async open(url) {
      let off;
      const loaded = new Promise((resolve) => {
        off = this.on((d) => d.method === 'Page.loadEventFired' && resolve());
      });
      await send('Page.navigate', { url });
      await loaded;
      off();
    },
    close: () => ws.close(),
  };
}

/** Arguments: the page's URL (the first bare one) and `--name value` flags. */
export function cli(usage) {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const page = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!page) {
    console.error(`usage: ${usage}`);
    process.exit(2);
  }
  return { page, flag, port: Number(flag('--cdp') ?? 9222) };
}

/** In the page: wait for the workspace's preview to settle (or `ms` to pass), then a few frames. */
export const SETTLE = `async function settle(ms = 15000) {
  const ws = () => document.querySelector('.workspace');
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const s = ws()?.dataset.preview;
    if (s === 'ready' || s === 'failed' || s === 'none') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => setTimeout(r, 150));
  const w = ws();
  return { state: w?.dataset.preview ?? 'no workspace', message: w?.querySelector('.preview-message')?.textContent ?? '' };
}`;

/** The examples the home page lists, by id. */
export async function examples(b) {
  return b.call(`async function () {
    location.hash = '#/';
    for (let i = 0; i < 40 && !document.querySelector('a[href^="#/example/"]'); i++) await new Promise((r) => setTimeout(r, 50));
    return [...document.querySelectorAll('a[href^="#/example/"]')].map((a) => a.getAttribute('href').split('/').pop());
  }`);
}
