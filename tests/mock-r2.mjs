/**
 * 테스트용 R2 스텁 + 정적 서버.
 *
 * 진짜 Cloudflare 없이 `shared/r2api.js` 를 그대로 돌리기 위한 것입니다.
 * 버킷은 메모리에 두고, R2 바인딩이 제공하는 만큼만 흉내냅니다
 * (get / put / delete + 조건부 쓰기 — R2Conditional 과 조건부 헤더 양쪽).
 */
import { createHash } from 'crypto';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize, sep } from 'path';
import { handleApi } from '../shared/r2api.js';

/* ------------------------------------------------------------- 버킷 스텁 -- */

export class MockBucket {
  constructor() { this.objects = new Map(); }

  static etagOf(bytes) { return createHash('md5').update(bytes).digest('hex'); }

  #toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new TextEncoder().encode(String(value));
  }

  async get(key) {
    const rec = this.objects.get(key);
    if (!rec) return null;
    return {
      key,
      etag: rec.etag,
      httpEtag: `"${rec.etag}"`,
      size: rec.bytes.length,
      httpMetadata: rec.httpMetadata,
      customMetadata: rec.customMetadata,
      body: rec.bytes,
      text: async () => new TextDecoder().decode(rec.bytes),
      arrayBuffer: async () => rec.bytes.buffer.slice(
        rec.bytes.byteOffset, rec.bytes.byteOffset + rec.bytes.byteLength),
    };
  }

  /** 조건이 어긋나면 R2 처럼 null 을 돌려줍니다. */
  async put(key, value, opts = {}) {
    const existing = this.objects.get(key);
    const cond = normalizeCondition(opts.onlyIf);

    if (cond?.etagMatches !== undefined) {
      if (cond.etagMatches === '*') { if (!existing) return null; }
      else if (!existing || existing.etag !== cond.etagMatches) return null;
    }
    if (cond?.etagDoesNotMatch !== undefined) {
      // '*' 는 RFC 7232 의 "대상이 없을 때만" 입니다 — 첫 생성 경쟁을 막습니다.
      if (cond.etagDoesNotMatch === '*') { if (existing) return null; }
      else if (existing && existing.etag === cond.etagDoesNotMatch) return null;
    }

    const bytes = this.#toBytes(value);
    const rec = {
      bytes,
      etag: MockBucket.etagOf(bytes),
      httpMetadata: opts.httpMetadata || {},
      customMetadata: opts.customMetadata || {},
    };
    this.objects.set(key, rec);
    return { key, etag: rec.etag, httpEtag: `"${rec.etag}"`, size: bytes.length };
  }

  async delete(key) { this.objects.delete(key); }

  /** 테스트 편의 — 접두어로 키 목록 보기 */
  keys(prefix = '') {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** Headers 로 준 조건부 헤더도 R2Conditional 과 같은 모양으로 맞춥니다. */
function normalizeCondition(onlyIf) {
  if (!onlyIf) return null;
  if (typeof onlyIf.get !== 'function') return onlyIf;      // 이미 R2Conditional
  const strip = (v) => (v === null ? undefined : String(v).replace(/^W\//, '').replace(/"/g, ''));
  const out = {};
  const match = strip(onlyIf.get('If-Match'));
  const none = strip(onlyIf.get('If-None-Match'));
  if (match !== undefined) out.etagMatches = match;
  if (none !== undefined) out.etagDoesNotMatch = none;
  return out;
}

/* ------------------------------------------------------- 정적 + API 서버 -- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * 사이트와 /api 를 같은 오리진에서 서비스합니다 — 실제 Pages 배포와 같은 구조.
 * @param {{root: string, env?: object, port?: number}} opts
 */
export async function startServer({ root, env = {}, port = 0 }) {
  const bucket = new MockBucket();
  const fullEnv = { BUCKET: bucket, ...env };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api')) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const request = new Request(url.href, {
        method: req.method,
        headers: req.headers,
        body,
        duplex: 'half',
      });
      const out = await handleApi(request, fullEnv, { basePath: '/api' });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      const buf = Buffer.from(await out.arrayBuffer());
      res.end(buf);
      return;
    }

    // 정적 파일
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    // 윈도우에서는 normalize('/') 가 역슬래시라, 루트 판정을 구분자 양쪽으로 봅니다.
    const isRoot = rel === '/' || rel === sep || rel === '';
    const file = join(root, isRoot ? 'index.html' : rel);
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  const actual = server.address().port;
  return { server, bucket, env: fullEnv, port: actual, origin: `http://localhost:${actual}` };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
