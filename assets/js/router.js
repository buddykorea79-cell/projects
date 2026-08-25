/** 해시 기반 라우터 — GitHub Pages 처럼 서버 라우팅이 없는 호스팅에 맞춥니다. */

const routes = [];
let notFound = () => '<p>페이지를 찾을 수 없습니다.</p>';
let onBefore = null;
let onAfter = null;

/**
 * @param {string} pattern  예: '/p/:id/submit'
 * @param {(params:object, query:URLSearchParams)=>any} handler
 */
export function route(pattern, handler) {
  const keys = [];
  const regex = new RegExp(`^${pattern
    .replace(/\/$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
  routes.push({ regex, keys, handler });
}

export function setNotFound(fn) { notFound = fn; }
export function beforeEach(fn) { onBefore = fn; }
export function afterEach(fn) { onAfter = fn; }

export function currentPath() {
  const raw = location.hash.replace(/^#/, '') || '/';
  return raw.split('?')[0].replace(/\/$/, '') || '/';
}

export function currentQuery() {
  const raw = location.hash.replace(/^#/, '');
  const qi = raw.indexOf('?');
  return new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
}

export function go(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) { resolve(); return; }
  if (replace) location.replace(target);
  else location.hash = target;
}

let resolving = false;
let queued = false;

/** 현재 주소에 맞는 화면을 한 번 그립니다. */
async function renderCurrent() {
  const path = currentPath();
  const query = currentQuery();
  if (onBefore) onBefore(path);

  for (const r of routes) {
    const m = path.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    await r.handler(params, query);
    if (onAfter) onAfter(path);
    return;
  }
  await notFound();
  if (onAfter) onAfter(path);
}

/**
 * 화면을 그리는 도중 또 이동이 들어오면(렌더가 끝나기 전에 링크를 누르는 경우)
 * 그 요청을 버리지 않고 큐에 넣었다가 이어서 처리합니다.
 * 그냥 return 하면 마지막 이동이 조용히 사라져 화면이 주소와 어긋납니다.
 */
export async function resolve() {
  if (resolving) { queued = true; return; }
  resolving = true;
  try {
    do {
      queued = false;
      await renderCurrent();
    } while (queued);
  } finally {
    resolving = false;
  }
}

export function start() {
  window.addEventListener('hashchange', () => resolve());
  resolve();
}
