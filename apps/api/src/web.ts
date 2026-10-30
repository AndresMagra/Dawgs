/**
 * Serves the built web apps from the API server, for a one-box deployment:
 * the customer site at `/`, the staff site at `/staff`, the API under `/api`.
 * A path that isn't a file gets the app's index.html (the apps route in the browser).
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export interface WebSite {
  /** URL prefix without a trailing slash; '' for the root site. */
  prefix: string;
  dir: string;
}

export function serveSites(app: FastifyInstance, sites: WebSite[]) {
  // Longest prefix first, so /staff/... never falls through to the root site.
  const ordered = [...sites].sort((a, b) => b.prefix.length - a.prefix.length).map((s) => ({ ...s, dir: resolve(s.dir) }));
  app.get('/*', { config: { public: true } }, async (req, reply) => {
    const path = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/\/+/g, '/'));
    const site = ordered.find((s) => path === s.prefix || path.startsWith(`${s.prefix}/`));
    if (!site) return reply.code(404).send({ error: 'NOT_FOUND', message: 'not found' });
    const rel = normalize(path.slice(site.prefix.length) || '/');
    const file = join(site.dir, rel);
    // Never serve outside the site's own folder.
    if (file !== site.dir && !file.startsWith(site.dir + sep)) return reply.code(404).send({ error: 'NOT_FOUND', message: 'not found' });
    let target = join(site.dir, 'index.html');
    try {
      if ((await stat(file)).isFile()) target = file;
    } catch {
      // Not a file: a route inside the app.
    }
    const type = TYPES[extname(target)] ?? 'application/octet-stream';
    // Built assets have hashed names and can be cached for long; the page itself must not be.
    const cache = target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
    return reply.header('content-type', type).header('cache-control', cache).send(await readFile(target));
  });
}
