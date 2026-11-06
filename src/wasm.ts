// The glue, loaded on first need: the .wasm is fetched with its progress shown, then instantiated from the bytes.
import init, { Shader } from '../pkg/iridia_web.js';
import wasmUrl from '../pkg/iridia_web_bg.wasm?url';

export type { Shader };

let loading: Promise<typeof Shader> | null = null;
const listeners = new Set<(loaded: number, total: number) => void>();

/** Calls `f` with the download's progress (bytes so far, total or 0 when the server states none). */
export function onProgress(f: (loaded: number, total: number) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

async function fetchWithProgress(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the glue (${url}) answered ${response.status} ${response.statusText}`);
  // a compressed response states the compressed length while the reader counts the bytes it gives: no total then
  const total = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length') ?? 0);
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    for (const f of listeners) f(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes.buffer;
}

/** The glue's `Shader` class, once loaded. */
export function glue(): Promise<typeof Shader> {
  loading ??= (async () => {
    const bytes = await fetchWithProgress(wasmUrl);
    await init({ module_or_path: bytes });
    return Shader;
  })();
  return loading;
}
