import type { AppState, Lyrics, LyricMatch } from '@/lib/types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Only these mean the lease is really gone; network errors (0) and 5xx are worth retrying. */
export const isLeaseLost = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 409);

/** A fresh random id per page load, so duplicated tabs never share a playback lease. */
export function newControllerId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface IngestResult { added: number; duplicates: number; errors: string[] }
export type Quality = 'balanced' | 'high';

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('content-type', 'application/json');
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Cannot reach the host. Check that the server is running and this device is on the same network.', 0);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

export const fetchState = (q: string, favorites: boolean, page: number, limit: number, signal?: AbortSignal) => {
  const p = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (q.trim()) p.set('q', q.trim());
  if (favorites) p.set('favorites', '1');
  return api<AppState>(`/api/state?${p}`, { signal });
};

export const authAction = (action: 'setup' | 'login' | 'logout' | 'password', password: string, newPassword?: string) =>
  api<{ ok: true }>('/api/auth', { method: 'POST', json: { action, password, newPassword } });

export const patchTrack = (id: string, patch: { title?: string; artist?: string; album?: string; favorite?: boolean; lyricOffset?: number }) =>
  api<{ ok: true }>(`/api/tracks/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch });

export const deleteTrack = (id: string) => api<{ ok: true }>(`/api/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const prepareTrack = (id: string, action: 'retry' | 'cancel', quality?: Quality) =>
  api<{ ok: true }>(`/api/tracks/${encodeURIComponent(id)}/prepare`, { method: 'POST', json: { action, quality } });

export const lyricMatches = (id: string) => api<{ matches: LyricMatch[] }>(`/api/tracks/${encodeURIComponent(id)}/lyrics`);
export const selectLyric = (id: string, matchId: number) =>
  api<{ lyrics: Lyrics }>(`/api/tracks/${encodeURIComponent(id)}/lyrics`, { method: 'POST', json: { matchId } });
export const lookupLyric = (id: string) =>
  api<{ lyrics: Lyrics }>(`/api/tracks/${encodeURIComponent(id)}/lyrics`, { method: 'POST', json: { action: 'lookup' } });

export const alignTrackLyrics = (id: string, action: 'start' | 'cancel' = 'start') =>
  api<{ ok: true }>(`/api/tracks/${encodeURIComponent(id)}/alignment`, { method: 'POST', json: { action } });

export const importFolder = (path: string, quality: Quality) =>
  api<IngestResult>('/api/import', { method: 'POST', json: { path, quality } });

export const queueAdd = (trackId: string, singer: string) => api<{ ok: true }>('/api/queue', { method: 'POST', json: { trackId, singer } });
export const queueReorder = (ids: string[]) => api<{ ok: true }>('/api/queue', { method: 'PATCH', json: { ids } });
export const queueRemove = (id: string) => api<{ ok: true }>('/api/queue', { method: 'DELETE', json: { id } });

export const session = (action: 'claim' | 'heartbeat' | 'release', controller: string, trackId?: string) =>
  api<{ ok: true }>('/api/session', { method: 'POST', json: { action, controller, trackId } });

/** Best-effort release while the page is closing. */
export function releaseOnExit(controller: string) {
  try {
    void fetch('/api/session', {
      method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'release', controller }),
    });
  } catch { /* nothing more to do */ }
}

export function uploadOne(file: File, quality: Quality, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<IngestResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      const body = xhr.response as (IngestResult & { error?: string }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else reject(new ApiError(body?.error ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('The upload was interrupted. Check the connection to the host and try again.', 0));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('quality', quality);
    form.append('files', file);
    xhr.send(form);
  });
}

export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatBytes(b: number): string {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
