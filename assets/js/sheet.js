/**
 * 표 파일 읽기·쓰기 — CSV 와 XLSX. 외부 라이브러리를 쓰지 않습니다.
 *
 * 이 사이트에는 빌드 도구가 없고 CDN 도 물지 않으므로(index.html 참고)
 * 필요한 만큼만 직접 구현했습니다.
 *
 *   readSheet(file)      CSV·XLSX → string[][]  (첫 시트, 셀은 전부 문자열)
 *   buildXlsx(sheets)    [{name, rows}] → Blob  (엑셀에서 바로 열립니다)
 *   buildCsv(rows)       string[][] → Blob      (엑셀용 BOM 포함)
 *
 * XLSX 는 XML 몇 장을 담은 ZIP 입니다. 읽을 때는 ZIP 을 풀어
 * `xl/worksheets/…`·`xl/sharedStrings.xml` 만 보고, 쓸 때는 압축하지 않는
 * (stored) 항목으로 담습니다 — CRC32 만 있으면 되고 엑셀은 그대로 받아줍니다.
 */

/* ====================================================== 읽기 — 진입점 == */

/**
 * 업로드된 파일을 표(행 × 열)로 읽습니다. 셀은 모두 문자열입니다.
 * @param {File|Blob} file
 * @returns {Promise<string[][]>}
 */
export async function readSheet(file) {
  const name = String(file?.name || '').toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());

  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
    return parseDelimited(decodeText(buf));
  }
  if (looksLikeZip(buf)) return readXlsx(buf);
  if (name.endsWith('.xls')) {
    throw new Error('예전 형식(.xls)은 읽을 수 없습니다. 엑셀에서 .xlsx 또는 CSV 로 저장한 뒤 올려주세요.');
  }
  // 확장자가 없거나 낯설어도 내용이 텍스트면 CSV 로 시도합니다.
  return parseDelimited(decodeText(buf));
}

const looksLikeZip = (buf) => buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7);

/**
 * 바이트를 문자열로. UTF-8 로 먼저 읽고, 깨진 문자(U+FFFD)가 보이면
 * 한국에서 흔한 EUC-KR(CP949)로 다시 읽습니다 — 엑셀이 저장한 CSV 가 대개 그렇습니다.
 */
export function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try {
    const euc = new TextDecoder('euc-kr').decode(buf);
    if (!euc.includes('�')) return euc.replace(/^﻿/, '');
  } catch { /* 이 브라우저가 euc-kr 을 모르면 UTF-8 결과를 씁니다 */ }
  return utf8.replace(/^﻿/, '');
}

/* ---------------------------------------------------------------- CSV -- */

/** 구분자를 스스로 고릅니다 — 첫 줄에 탭이 더 많으면 TSV 로 봅니다. */
function guessDelimiter(text) {
  const head = text.slice(0, 4000).split(/\r?\n/)[0] || '';
  const count = (ch) => head.split(ch).length - 1;
  const tabs = count('\t');
  const semis = count(';');
  const commas = count(',');
  if (tabs > commas && tabs >= semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * 따옴표 안의 쉼표·줄바꿈·이스케이프("")를 지키며 CSV/TSV 를 읽습니다.
 * @returns {string[][]}
 */
export function parseDelimited(text, delimiter = null) {
  const d = delimiter || guessDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // 파일 끝의 빈 줄은 버립니다.
  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
  return rows;
}

/* --------------------------------------------------------------- XLSX -- */

async function readXlsx(buf) {
  const files = await unzip(buf);
  const shared = parseSharedStrings(files['xl/sharedStrings.xml']);
  const sheetPath = firstSheetPath(files);
  const xml = files[sheetPath];
  if (!xml) throw new Error('엑셀 파일에서 시트를 찾지 못했습니다.');
  return parseSheetXml(text(xml), shared);
}

/** 워크북이 가리키는 첫 시트를 찾습니다. 못 찾으면 sheet1 로 떨어집니다. */
function firstSheetPath(files) {
  const wb = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (wb && rels) {
    const first = text(wb).match(/<sheet\b[^>]*\/?>/);
    const rid = first && first[0].match(/r:id="([^"]+)"/);
    if (rid) {
      const rel = text(rels).match(new RegExp(`<Relationship\\b[^>]*Id="${rid[1]}"[^>]*>`));
      const target = rel && rel[0].match(/Target="([^"]+)"/);
      if (target) {
        const p = target[1].replace(/^\/?xl\//, '').replace(/^\.\//, '');
        if (files[`xl/${p}`]) return `xl/${p}`;
      }
    }
  }
  if (files['xl/worksheets/sheet1.xml']) return 'xl/worksheets/sheet1.xml';
  return Object.keys(files).find((k) => /^xl\/worksheets\/.+\.xml$/.test(k)) || '';
}

const text = (bytes) => new TextDecoder('utf-8').decode(bytes);

/** 공유 문자열 테이블 — <si> 하나가 문자열 하나입니다(<t> 조각을 이어 붙임). */
function parseSharedStrings(bytes) {
  if (!bytes) return [];
  const xml = text(bytes);
  const out = [];
  const siRe = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = siRe.exec(xml))) out.push(m[1] ? joinText(m[1]) : '');
  return out;
}

/** <t> 조각들을 이어 붙입니다. <rPh>(후리가나) 같은 곁가지는 버립니다. */
function joinText(fragment) {
  const cleaned = fragment.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const tRe = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = tRe.exec(cleaned))) out += unescapeXml(m[1] || '');
  return out;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** "BC12" → 열 번호(0부터). */
export function colIndex(ref) {
  const letters = String(ref || '').match(/^[A-Z]+/i);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheetXml(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;

  while ((rm = rowRe.exec(xml))) {
    const attrs = rm[1] || '';
    const inner = rm[2] || '';
    const rAttr = attrs.match(/\br="(\d+)"/);
    const rowIdx = rAttr ? Number(rAttr[1]) - 1 : rows.length;

    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let auto = 0;
    while ((cm = cellRe.exec(inner))) {
      const cAttrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = cAttrs.match(/\br="([A-Z]+\d+)"/i);
      const at = ref ? colIndex(ref[1]) : auto;
      auto = at + 1;
      cells[at] = cellValue(cAttrs, body, shared);
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = '';
    rows[rowIdx] = cells;
  }
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];

  while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
  return rows;
}

function cellValue(attrs, body, shared) {
  const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
  if (t === 'inlineStr') return joinText(body);
  const v = body.match(/<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/);
  const raw = v ? unescapeXml(v[1]) : '';
  if (t === 's') return shared[Number(raw)] ?? '';
  if (t === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

/* ================================================== ZIP — 풀기 / 담기 == */

/**
 * ZIP 을 풀어 { 경로: Uint8Array } 로 돌려줍니다.
 * 중앙 디렉터리를 읽고, 압축된 항목은 DecompressionStream 으로 풉니다.
 */
export async function unzip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // 끝에서부터 EOCD(PK\x05\x06)를 찾습니다. 주석이 붙어 있어도 65KB 안에 있습니다.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('올바른 엑셀(zip) 파일이 아닙니다.');

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const out = {};

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localAt = view.getUint32(ptr + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));

    // 지역 헤더의 이름·extra 길이는 중앙 디렉터리와 다를 수 있어 다시 읽습니다.
    const lNameLen = view.getUint16(localAt + 26, true);
    const lExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    if (!name.endsWith('/')) out[name] = method === 0 ? raw : await inflateRaw(raw);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('이 브라우저에서는 xlsx 를 풀 수 없습니다. CSV 로 저장해 올려주세요.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 압축하지 않는(stored) ZIP 을 만듭니다. 엑셀 파일은 XML 몇 장이라
 * 압축하지 않아도 충분히 작고, 코드가 훨씬 단순합니다.
 * @param {Array<{name:string, data:Uint8Array}>} entries
 */
export function zipStore(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0x0800, true);        // UTF-8 파일명
    lv.setUint16(8, 0, true);             // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const head = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    head.set(nameBytes, 46);
    central.push(head);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

/* ====================================================== 쓰기 — XLSX == */

function escXml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 엑셀이 거부하는 제어문자는 미리 털어냅니다.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/** 0 → "A", 26 → "AA" */
export function colName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const isNumeric = (v) => typeof v === 'number'
  || (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v)));

function sheetXml(rows, { headerRow = true } = {}) {
  const body = rows.map((cells, r) => {
    const tds = (cells || []).map((value, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const style = headerRow && r === 0 ? ' s="1"' : '';
      if (value === null || value === undefined || value === '') return `<c r="${ref}"${style}/>`;
      // 숫자로 저장해야 엑셀에서 합계·정렬이 그대로 먹습니다.
      if (isNumeric(value)) return `<c r="${ref}"${style}><v>${escXml(value)}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${tds}</row>`;
  }).join('');

  const widest = rows.reduce((n, r) => Math.max(n, (r || []).length), 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<cols><col min="1" max="1" width="18" customWidth="1"/>`
    + `<col min="2" max="${Math.max(2, widest)}" width="13" customWidth="1"/></cols>`
    + `<sheetData>${body}</sheetData></worksheet>`;
}

/**
 * 여러 장짜리 xlsx 를 만듭니다. 첫 줄은 굵게 나옵니다.
 * @param {Array<{name:string, rows:Array<Array<string|number>>}>} sheets
 * @returns {Blob}
 */
export function buildXlsx(sheets) {
  const enc = new TextEncoder();
  const list = (sheets || []).filter(Boolean);
  if (!list.length) throw new Error('내보낼 내용이 없습니다.');

  // 시트 이름에 엑셀이 금지하는 문자가 있으면 바꿔줍니다(31자 제한).
  const names = list.map((s, i) => String(s.name || `Sheet${i + 1}`)
    .replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);

  const entries = [
    {
      name: '[Content_Types].xml',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '</Types>'),
    },
    {
      name: '_rels/.rels',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>'),
    },
    {
      name: 'xl/workbook.xml',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + names.map((n, i) => `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + '</Relationships>'),
    },
    {
      // 머리글 한 줄만 굵게 — 스타일 1번이 그것입니다.
      name: 'xl/styles.xml',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font>'
        + '<font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>'
        + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        + '<fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border/></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        + '</styleSheet>'),
    },
    ...list.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(sheetXml(s.rows || [])),
    })),
  ];

  return new Blob([zipStore(entries)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** 엑셀이 한글을 바로 알아보도록 BOM 을 붙인 CSV. */
export function buildCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = (rows || []).map((r) => (r || []).map(cell).join(',')).join('\r\n');
  return new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8' });
}
