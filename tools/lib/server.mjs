// Show capability (Annex I.4): a loopback-only, read-only server for the view.
// It answers GET and HEAD for an exact allowlist — the view assets, state.json and
// events.jsonl — and nothing else. Evidence is never served. Paths are matched as
// received, so no normalisation can turn a traversal attempt into an allowed file.
import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 7431;
export const VIEW_DIR = fileURLToPath(new URL('../../app/web-ui/', import.meta.url));

const JS = 'text/javascript; charset=utf-8';
export const VIEW_ASSETS = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', JS],
  '/render.mjs': ['render.mjs', JS],
  '/freshness.mjs': ['freshness.mjs', JS],
});
const RECORDS = Object.freeze({
  '/state.json': ['state.json', 'application/json; charset=utf-8'],
  '/events.jsonl': ['events.jsonl', 'text/plain; charset=utf-8'],
});

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

// Read a regular file without following a symbolic link at its final component.
async function readRegular(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null;
  } finally {
    await handle.close();
  }
}

export function startViewServer({ workspace, port = DEFAULT_PORT }) {
  let actualPort;
  const server = createServer(async (req, res) => {
    const send = (status, headers, body) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Discard any body unread, then refuse and close the connection.
      req.resume();
      return req.once('end', () => send(405, { allow: 'GET, HEAD', 'content-type': 'text/plain', connection: 'close' }, 'read-only\n'));
    }
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) {
      return send(421, { 'content-type': 'text/plain' }, 'wrong host\n');
    }
    const asset = VIEW_ASSETS[req.url];
    const record = RECORDS[req.url];
    if (!asset && !record) return send(404, { 'content-type': 'text/plain' }, 'not found\n');
    const [file, type] = asset ?? record;
    const body = await readRegular(join(asset ? VIEW_DIR : workspace, file));
    if (body === null) return send(404, { 'content-type': 'text/plain' }, 'not found\n');
    return send(200, { 'content-type': type }, body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}/`,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
