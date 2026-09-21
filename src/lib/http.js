import fs from 'node:fs';
import path from 'node:path';

export const QA_MODE =
  String(process.env.QA_MODE ?? 'true').toLowerCase() === 'true';

const MAX_BODY_BYTES = 1_000_000;

/* A refused request is drained so the 413 reaches the client, but only up to
 * this ceiling, past which the connection is cut. */
const HARD_BODY_LIMIT = 10 * MAX_BODY_BYTES;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

export function send(res, status, data, headers = {}) {
  const isText = typeof data === 'string';

  res.writeHead(status, {
    'Content-Type': isText
      ? 'text/plain; charset=utf-8'
      : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });

  res.end(isText ? data : JSON.stringify(data));
}

export function error(res, status, message, details) {
  send(res, status, { error: message, ...(details ? { details } : {}) });
}

export function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let received = 0;
    let refused = false;

    const tooLarge = () =>
      Object.assign(new Error('Request body too large.'), { status: 413 });

    req.on('data', chunk => {
      received += chunk.length;

      if (!refused && received > MAX_BODY_BYTES) {
        // Stop buffering, but keep draining. Answering while the client is
        // still uploading makes some clients see a connection reset rather
        // than the 413, so the remaining bytes are read and discarded and the
        // refusal is sent once the request has finished.
        refused = true;
        data = '';
      }

      if (refused) {
        // A client that ignores the refusal and keeps sending is cut off
        // rather than allowed to consume memory indefinitely.
        if (received > HARD_BODY_LIMIT) {
          req.destroy();
          reject(tooLarge());
        }
        return;
      }

      data += chunk;
    });

    req.on('end', () => {
      if (refused) return reject(tooLarge());
      if (!data) return resolve({});

      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

export function sendFile(res, buffer, mime, filename) {
  res.writeHead(200, {
    'Content-Type': mime || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${String(filename).replaceAll('"', '')}"`,
    'Cache-Control': 'no-store'
  });
  res.end(buffer);
}

/*
 * Serves the SPA. Any path that is not a real file falls back to index.html so
 * client-side routes survive a page reload, which mirrors the rewrite rule in
 * vercel.json.
 */
export function serveStatic(req, res, url, publicDir) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  let file = path.join(publicDir, pathname);

  if (!file.startsWith(publicDir)) {
    return error(res, 403, 'Forbidden.');
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(publicDir, 'index.html');
  }

  const ext = path.extname(file);

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
  });

  fs.createReadStream(file).pipe(res);
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim();
}

export function moneyMinor(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NaN;
  return Math.round(amount * 100);
}
