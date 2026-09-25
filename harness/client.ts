/** Speaks plain HTTP to a transport — the harness never calls engine functions. */
export interface Transport {
  base: string;
  fetch(req: Request): Promise<Response>;
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
  url: string;
}

export class AcspClient {
  requests = 0;
  constructor(readonly transport: Transport) {}

  url(path: string): string {
    return path.startsWith('http') ? path : new URL(path, this.transport.base).toString();
  }

  async request(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<HttpResult> {
    const url = this.url(path);
    this.requests++;
    const res = await this.transport.fetch(new Request(url, { method, body: opts.body, headers: opts.headers }));
    const text = await res.text();
    let body: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        /* leave as text */
      }
    }
    return { status: res.status, body, text, headers: res.headers, url };
  }

  getJson(path: string, token?: string | null) {
    return this.request('GET', path, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  }

  /** What a browser-only agent does: open a URL, no custom headers. */
  getHtml(path: string) {
    return this.request('GET', path, { headers: { Accept: 'text/html' } });
  }

  postJson(path: string, body: unknown, token?: string | null) {
    return this.request('POST', path, {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  }

  postForm(path: string, fields: Record<string, string>) {
    return this.request('POST', path, {
      body: new URLSearchParams(fields).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}

/** Extract the JSON document embedded in an ACSP HTML page. */
export function embeddedDocument(html: string): any {
  const m = /<script type="application\/json" id="acsp-document">\s*([\s\S]*?)\s*<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

/** Find <link rel="alternate" type="application/json" href="…"> — how an agent discovers the JSON. */
export function alternateJsonHref(html: string): string | null {
  const m = /<link rel="alternate" type="application\/json" href="([^"]+)"/.exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

/** Plain text as an agent's HTML-to-text browser might see it. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}
