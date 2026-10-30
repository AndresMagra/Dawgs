/**
 * One small client for both apps. The token lives wherever the app keeps it
 * (SecureStore on phones, localStorage on the web); this file only needs a
 * getter and a setter.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string | null): Promise<void>;
}

export class Api {
  onUnauthorized: (() => void) | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly tokens: TokenStore,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokens.get();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      if (res.status === 401 && token) {
        await this.tokens.set(null);
        this.onUnauthorized?.();
      }
      throw new ApiError(res.status, json?.error ?? 'ERROR', json?.message ?? `request failed (${res.status})`);
    }
    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, body);
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }
  del<T>(path: string) {
    return this.request<T>('DELETE', path);
  }

  async login(email: string, password: string) {
    const r = await this.post<{ token: string; user: import('./types').User }>('/auth/login', { email, password });
    await this.tokens.set(r.token);
    return r.user;
  }

  async logout() {
    await this.post('/auth/logout').catch(() => undefined);
    await this.tokens.set(null);
  }

  async setToken(token: string | null) {
    await this.tokens.set(token);
  }

  async hasToken() {
    return Boolean(await this.tokens.get());
  }
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : '';
}
