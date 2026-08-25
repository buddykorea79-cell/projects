/** 공용 유틸리티 — DOM, 포맷, 검증, 해시. */

/* ------------------------------------------------------------------ DOM -- */

/** HTML 이스케이프. 사용자가 넣은 문자열은 반드시 이걸 거쳐 innerHTML 로 갑니다. */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 속성값용 이스케이프 (esc 와 동일하지만 의도를 드러내기 위해 별도 이름). */
export const attr = esc;

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 이벤트 위임 헬퍼. */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) handler(e, t);
  });
}

/* --------------------------------------------------------------- format -- */

const KST = 'Asia/Seoul';

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: KST };
  if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; opts.hour12 = false; }
  return new Intl.DateTimeFormat('ko-KR', opts).format(d).replace(/\.$/, '');
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000]];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return '방금';
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 마감일이 지났는지. dueAt 없으면 항상 false. */
export function isPastDue(dueAt) {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < Date.now();
}

/** datetime-local 입력값 <-> ISO 변환 */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ------------------------------------------------------------- validate -- */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(v) { return EMAIL_RE.test(String(v || '').trim()); }

export function normEmail(v) { return String(v || '').trim().toLowerCase(); }

export function extOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function kindOf(file) {
  const ext = extOf(file.name || '');
  const type = file.type || '';
  if (type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','svg','heic'].includes(ext)) return 'image';
  if (type.startsWith('video/') || ['mp4','webm','mov','m4v'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return 'file';
}

/* ----------------------------------------------------------------- misc -- */

/** 충돌 가능성이 낮은 짧은 ID. */
export function uid(prefix = '') {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${t}${r}`;
}

/** 사람이 받아적기 좋은 수정코드 (혼동 문자 0/O/1/I/L 제외). */
export function makeCode(len = 6) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 파일명을 저장소에 안전한 형태로. 한글은 유지합니다. */
export function safeName(name) {
  return String(name || 'file')
    .replace(/[\\/:*?"<>|#%&{}$!'`+=@]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-120);
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** CSV 한 줄 이스케이프. */
export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 텍스트에서 처음 나오는 http(s) 주소. 없으면 null. */
export function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/);
  if (!m) return null;
  return m[0].replace(/[.,!?)\]}]+$/, '') || null;
}

/**
 * 텍스트 안의 http(s) 주소를 새 창으로 열리는 링크로 바꿉니다.
 *
 * 먼저 esc() 로 전부 이스케이프한 뒤 링크 태그만 끼워 넣기 때문에
 * 본문에 HTML 을 써넣어도 주입되지 않습니다. http/https 만 인식하므로
 * javascript: 같은 스킴은 링크가 되지 않습니다.
 */
export function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, (match) => {
    // "…참고하세요." 처럼 뒤에 붙은 문장부호는 주소에서 떼어냅니다.
    // 세미콜론은 &amp; 같은 엔티티의 끝이라 일부러 제외했습니다.
    const trail = match.match(/[.,!?)\]}]+$/);
    const url = trail ? match.slice(0, -trail[0].length) : match;
    if (!url) return match;
    const href = url.replace(/&amp;/g, '&');
    return `<a href="${attr(href)}" target="_blank" rel="noopener noreferrer">${url}</a>`
      + (trail ? trail[0] : '');
  });
}

/**
 * 첨부를 내려받는 링크의 href 와 부가 속성을 저장소별로 만들어 줍니다.
 *  - r2     : 같은 도메인 API. `download=1` 을 붙이면 서버가 파일명까지 지정합니다.
 *  - github : raw 주소는 다른 도메인이라 download 속성이 먹지 않습니다. 새 탭으로.
 *  - idb    : blob: URL 이므로 download 속성으로 파일명을 지정합니다.
 */
export function downloadLink(url, fileRef) {
  if (!url) return null;
  if (fileRef?.storage === 'r2') {
    return { href: `${url}${url.includes('?') ? '&' : '?'}download=1`, attrs: '' };
  }
  if (fileRef?.storage === 'github') {
    return { href: url, attrs: 'target="_blank" rel="noopener"' };
  }
  return { href: url, attrs: `download="${esc(fileRef?.name || 'file')}"` };
}

/** 브라우저에서 파일 다운로드를 트리거합니다. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 유니코드 문자열 -> base64. (btoa 는 Latin-1 만 받으므로 바이트로 먼저 변환합니다.) */
export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;   // 인자 개수 제한을 피하려고 나눠서 처리합니다.
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** File -> base64 (data: 접두어 없이) */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
