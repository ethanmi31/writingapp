async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url)
};

/** POSTs and reads a Server-Sent Events stream. handlers: { meta, token, reasoning, done, tracker, error } */
export async function streamPost(url, body, handlers, signal) {
  const res = await fetch(`/api${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = raw.match(/^event: (.*)$/m)?.[1];
      const data = raw.match(/^data: (.*)$/m)?.[1];
      if (event && data) handlers[event]?.(JSON.parse(data));
    }
  }
}

/** Sends files as multipart form data. */
export function upload(url, files, field = 'files', extra = {}) {
  const fd = new FormData();
  for (const f of files) fd.append(field, f);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return api.post(url, fd);
}

export const fmtCost = (c) => (c == null ? '—' : c < 0.01 ? `$${Number(c).toFixed(4)}` : `$${Number(c).toFixed(2)}`);
export const fmtNum = (n) => Number(n || 0).toLocaleString();
export const tokens = (t) => Math.ceil(String(t || '').length / 3.6);
export const wordCount = (t) => (String(t || '').match(/\S+/g) || []).length;

export const load = (k, d) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
};
export const store = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};
