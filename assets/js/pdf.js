/**
 * 자체 A4 한국어 PDF 생성기 (외부 CDN·폰트 의존성 없음, strict CSP 호환).
 * HTML5 Canvas로 고해상도 A4 페이지를 그린 뒤 JPEG 스트림(/DCTDecode)을
 * 표준 PDF 1.4 바이너리로 직접 조립해 다운로드합니다.
 */

const A4_PT_W = 595.28;
const A4_PT_H = 841.89;
const PAGE_PX_W = 1654; // 200 DPI A4 portrait
const PAGE_PX_H = 2339;
const FONT_FAMILY = '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", "NanumGothic", sans-serif';

const encoder = new TextEncoder();

function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function ascii(text) {
  return encoder.encode(text);
}

/**
 * JPEG 이미지 배열을 A4 다중 페이지 PDF 1.4 바이너리로 조립합니다.
 * @param {{ bytes: Uint8Array, width: number, height: number }[]} pages
 * @returns {Uint8Array}
 */
export function buildPdfFromJpegs(pages) {
  if (!Array.isArray(pages) || !pages.length) {
    throw new Error('PDF로 변환할 페이지가 없습니다.');
  }
  const chunks = [];
  let cursor = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    cursor += bytes.byteLength;
  };
  const pushText = (text) => push(ascii(text));

  // Header + binary marker
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object numbering:
  // 1: Catalog, 2: Pages
  // For page i (0-based): imgObj = 3 + i*3, contentObj = 4 + i*3, pageObj = 5 + i*3
  const totalObjects = 2 + pages.length * 3;
  const offsets = new Array(totalObjects + 1).fill(0);
  const pageRefs = pages.map((_, i) => `${5 + i * 3} 0 R`).join(' ');

  const startObj = (num) => {
    offsets[num] = cursor;
    pushText(`${num} 0 obj\n`);
  };

  startObj(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObj(2);
  pushText(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const imgNum = 3 + i * 3;
    const cntNum = 4 + i * 3;
    const pgNum = 5 + i * 3;
    const bytes = page.bytes instanceof Uint8Array ? page.bytes : new Uint8Array(page.bytes);

    startObj(imgNum);
    pushText(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.byteLength} >>\nstream\n`,
    );
    push(bytes);
    pushText('\nendstream\nendobj\n');

    const streamText = `q\n${A4_PT_W.toFixed(2)} 0 0 ${A4_PT_H.toFixed(2)} 0 0 cm\n/Im1 Do\nQ\n`;
    const streamBytes = ascii(streamText);
    startObj(cntNum);
    pushText(`<< /Length ${streamBytes.byteLength} >>\nstream\n`);
    push(streamBytes);
    pushText('endstream\nendobj\n');

    startObj(pgNum);
    pushText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_PT_W.toFixed(2)} ${A4_PT_H.toFixed(2)}] `
      + `/Resources << /XObject << /Im1 ${imgNum} 0 R >> >> /Contents ${cntNum} 0 R >>\nendobj\n`,
    );
  });

  const xrefOffset = cursor;
  pushText(`xref\n0 ${totalObjects + 1}\n`);
  pushText('0000000000 65535 f \n');
  for (let num = 1; num <= totalObjects; num += 1) {
    pushText(`${String(offsets[num]).padStart(10, '0')} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return concatBytes(chunks);
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('서명 이미지를 불러오지 못했습니다.'));
    img.src = src;
  });
}

function formatKst(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm} (KST)`;
}

function formatKoreanDate(iso) {
  const date = iso ? new Date(iso) : new Date();
  const kst = new Date((Number.isNaN(date.getTime()) ? Date.now() : date.getTime()) + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
}

function wrapText(ctx, text, maxWidth, maxLines = 2) {
  const str = String(text || '');
  const lines = [];
  let line = '';
  for (const ch of str) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines - 1) {
        let rest = str.slice(lines.join('').length);
        while (rest.length > 1 && ctx.measureText(`${rest}…`).width > maxWidth) {
          rest = rest.slice(0, -1);
        }
        lines.push(ctx.measureText(rest).width > maxWidth ? `${rest.slice(0, -1)}…` : rest);
        return lines;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function createPageCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_PX_W;
  canvas.height = PAGE_PX_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_PX_W, PAGE_PX_H);
  return { canvas, ctx };
}

/**
 * 예선 심사 완료 결과표를 고해상도 A4 PDF Blob으로 생성합니다.
 * @param {object} completion
 * @param {{ scoreMode?: 'both'|'converted'|'raw' }} [options]
 * @returns {Promise<Blob>}
 */
export async function renderPrelimResultPdfBlob(completion, { scoreMode = 'both' } = {}) {
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* 시스템 폰트로 진행 */ }
  }
  const sigImg = completion.signatureDataUrl ? await loadImage(completion.signatureDataUrl).catch(() => null) : null;

  const MARGIN_X = 110;
  const CONTENT_W = PAGE_PX_W - MARGIN_X * 2;
  const FOOTER_Y = PAGE_PX_H - 80;
  const MAX_BODY_Y = FOOTER_Y - 56;
  const TABLE_HEAD_H = 66;
  const ROW_H = 74;
  const SIG_BLOCK_H = 380;

  const cols = [
    { key: 'rank', label: '순위', width: 96, align: 'center' },
    { key: 'title', label: '작품명 (블라인드)', width: 518, align: 'left' },
    { key: 'c0', label: '문제 인식\n(40점·×4)', width: 162, align: 'center' },
    { key: 'c1', label: '기능 구현\n(30점·×3)', width: 162, align: 'center' },
    { key: 'c2', label: '완성도\n(20점·×2)', width: 158, align: 'center' },
    { key: 'c3', label: '확산 가능성\n(10점·×1)', width: 162, align: 'center' },
    { key: 'total', label: '환산 총점\n(100점)', width: 176, align: 'center' },
  ];

  const rows = Array.isArray(completion.rankedResults) ? completion.rankedResults : [];
  const pages = [];

  const drawHeader = (ctx, isFirstPage) => {
    let y = 96;
    if (isFirstPage) {
      // Top accent bar
      ctx.fillStyle = '#1E3932';
      ctx.fillRect(MARGIN_X, y, CONTENT_W, 10);
      y += 42;

      ctx.fillStyle = '#a51e57';
      ctx.font = `700 26px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('말하는 대로, 바이브 코딩 페스타', MARGIN_X, y);
      y += 40;

      ctx.fillStyle = '#111111';
      ctx.font = `700 46px ${FONT_FAMILY}`;
      ctx.fillText(`${completion.panelLabel || '예선 심사'} 평가 결과표`, MARGIN_X, y);
      y += 72;

      // Meta box
      ctx.fillStyle = '#f6f7f6';
      ctx.strokeStyle = '#d4dcd8';
      ctx.lineWidth = 2;
      ctx.fillRect(MARGIN_X, y, CONTENT_W, 96);
      ctx.strokeRect(MARGIN_X, y, CONTENT_W, 96);

      ctx.fillStyle = '#222222';
      ctx.font = `500 22px ${FONT_FAMILY}`;
      ctx.fillText(
        `심사 기준: 문제 인식 40점(×4) · 기능 구현 수준 30점(×3) · 완성도 20점(×2) · 확산 가능성 10점(×1) · 총 100점`,
        MARGIN_X + 24, y + 18,
      );
      ctx.fillStyle = '#4a5550';
      ctx.font = `400 21px ${FONT_FAMILY}`;
      const modeLabel = scoreMode === 'raw' ? '원점수(1~10)' : scoreMode === 'converted' ? '환산점수(100점)' : '환산점수(원점수 1~10)';
      const previewTag = completion.adminPreview ? '  |  [관리자 점검용]' : '';
      ctx.fillText(
        `평가 작품 수: ${rows.length}건  |  표시 방식: ${modeLabel}  |  심사 완료: ${formatKst(completion.completedAt)}${previewTag}`,
        MARGIN_X + 24, y + 54,
      );
      y += 126;
    } else {
      ctx.fillStyle = '#1E3932';
      ctx.font = `700 26px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${completion.panelLabel || '예선 심사'} 평가 결과표 (계속)`, MARGIN_X, y);
      y += 48;
    }
    return y;
  };

  const drawTableHeader = (ctx, y) => {
    ctx.fillStyle = '#1E3932';
    ctx.fillRect(MARGIN_X, y, CONTENT_W, TABLE_HEAD_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 20px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    let x = MARGIN_X;
    for (const col of cols) {
      const parts = col.label.split('\n');
      ctx.textAlign = 'center';
      if (parts.length === 1) {
        ctx.fillText(parts[0], x + col.width / 2, y + TABLE_HEAD_H / 2);
      } else {
        ctx.fillText(parts[0], x + col.width / 2, y + TABLE_HEAD_H / 2 - 12);
        ctx.font = `400 17px ${FONT_FAMILY}`;
        ctx.fillText(parts[1], x + col.width / 2, y + TABLE_HEAD_H / 2 + 14);
        ctx.font = `700 20px ${FONT_FAMILY}`;
      }
      x += col.width;
    }
    return y + TABLE_HEAD_H;
  };

  const formatCell = (row, idx) => {
    const conv = row.scores?.[idx] ?? 0;
    const raw = row.rawScores?.[idx];
    if (scoreMode === 'raw' && raw != null) return `${raw}`;
    if (scoreMode === 'converted' || raw == null) return `${conv}`;
    return `${conv} (${raw})`;
  };

  let current = createPageCanvas();
  pages.push(current);
  let y = drawHeader(current.ctx, true);
  y = drawTableHeader(current.ctx, y);

  rows.forEach((row, index) => {
    if (y + ROW_H > MAX_BODY_Y) {
      current = createPageCanvas();
      pages.push(current);
      y = drawHeader(current.ctx, false);
      y = drawTableHeader(current.ctx, y);
    }
    const { ctx } = current;
    ctx.fillStyle = index % 2 === 1 ? '#f9fbfa' : '#ffffff';
    ctx.fillRect(MARGIN_X, y, CONTENT_W, ROW_H);

    // Cell borders
    ctx.strokeStyle = '#d4dcd8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(MARGIN_X, y, CONTENT_W, ROW_H);

    let x = MARGIN_X;
    ctx.textBaseline = 'middle';
    for (let c = 0; c < cols.length; c += 1) {
      const col = cols[c];
      if (c > 0) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + ROW_H);
        ctx.stroke();
      }
      if (col.key === 'rank') {
        ctx.fillStyle = '#1E3932';
        ctx.font = `700 23px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(`${row.rank}위`, x + col.width / 2, y + ROW_H / 2);
      } else if (col.key === 'title') {
        ctx.fillStyle = '#111111';
        ctx.font = `500 21px ${FONT_FAMILY}`;
        ctx.textAlign = 'left';
        const lines = wrapText(ctx, row.title, col.width - 28, 2);
        if (lines.length === 1) {
          ctx.fillText(lines[0], x + 14, y + ROW_H / 2);
        } else {
          ctx.fillText(lines[0], x + 14, y + ROW_H / 2 - 14);
          ctx.fillText(lines[1], x + 14, y + ROW_H / 2 + 14);
        }
      } else if (col.key === 'total') {
        ctx.fillStyle = '#a51e57';
        ctx.font = `700 24px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        const rawSum = Array.isArray(row.rawScores) ? row.rawScores.reduce((a, b) => a + b, 0) : null;
        const label = scoreMode === 'raw' && rawSum != null ? `${rawSum} / 40` : `${row.total}점`;
        ctx.fillText(label, x + col.width / 2, y + ROW_H / 2);
      } else {
        const ci = Number(col.key.slice(1));
        ctx.fillStyle = '#222222';
        ctx.font = `500 21px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(formatCell(row, ci), x + col.width / 2, y + ROW_H / 2);
      }
      x += col.width;
    }
    y += ROW_H;
  });

  // Table footnote
  y += 18;
  current.ctx.fillStyle = '#555555';
  current.ctx.font = `400 18px ${FONT_FAMILY}`;
  current.ctx.textAlign = 'left';
  current.ctx.textBaseline = 'top';
  current.ctx.fillText(
    '※ 블라인드 심사로 출품자의 소속과 성명은 표시하지 않습니다. 환산점수 = 원점수(1~10) × 항목별 가중치(4·3·2·1).',
    MARGIN_X, y,
  );
  y += 44;

  // Signature block (keep together)
  if (y + SIG_BLOCK_H > MAX_BODY_Y) {
    current = createPageCanvas();
    pages.push(current);
    y = drawHeader(current.ctx, false) + 20;
  }

  const { ctx } = current;
  ctx.fillStyle = '#f8faf9';
  ctx.strokeStyle = '#1E3932';
  ctx.lineWidth = 2;
  ctx.fillRect(MARGIN_X, y, CONTENT_W, 92);
  ctx.strokeRect(MARGIN_X, y, CONTENT_W, 92);

  ctx.fillStyle = '#111111';
  ctx.font = `500 22px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    '본 심사위원은 상기 작품들에 대하여 공정하고 객관적으로 예선 심사를 완료하였으며,',
    MARGIN_X + CONTENT_W / 2, y + 32,
  );
  ctx.fillText(
    '위 평가 결과 및 순위에 이상이 없음을 확인하고 심사 완료에 동의합니다.',
    MARGIN_X + CONTENT_W / 2, y + 64,
  );
  y += 118;

  // Date centered
  ctx.fillStyle = '#222222';
  ctx.font = `700 24px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.fillText(formatKoreanDate(completion.completedAt), MARGIN_X + CONTENT_W / 2, y + 16);
  y += 52;

  // Official signer table: 소속 | 직급 | 성명 | 서명
  const sigCols = [
    { label: '소속', width: 410, value: completion.affiliation || '' },
    { label: '직급', width: 280, value: completion.position || '' },
    { label: '성명', width: 280, value: completion.name || '' },
    { label: '서명', width: CONTENT_W - 410 - 280 - 280, value: '' },
  ];
  const sigHeadH = 54;
  const sigBodyH = 148;

  ctx.fillStyle = '#e9f0ec';
  ctx.fillRect(MARGIN_X, y, CONTENT_W, sigHeadH);
  ctx.strokeStyle = '#8fa39a';
  ctx.lineWidth = 2;
  ctx.strokeRect(MARGIN_X, y, CONTENT_W, sigHeadH + sigBodyH);

  let sx = MARGIN_X;
  for (let i = 0; i < sigCols.length; i += 1) {
    const sc = sigCols[i];
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(sx, y);
      ctx.lineTo(sx, y + sigHeadH + sigBodyH);
      ctx.stroke();
    }
    ctx.fillStyle = '#1E3932';
    ctx.font = `700 22px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sc.label, sx + sc.width / 2, y + sigHeadH / 2);

    if (sc.label === '서명') {
      if (sigImg) {
        const pad = 12;
        const boxW = sc.width - pad * 2;
        const boxH = sigBodyH - pad * 2;
        const scale = Math.min(boxW / sigImg.naturalWidth, boxH / sigImg.naturalHeight);
        const dw = sigImg.naturalWidth * scale;
        const dh = sigImg.naturalHeight * scale;
        ctx.drawImage(
          sigImg,
          sx + (sc.width - dw) / 2,
          y + sigHeadH + (sigBodyH - dh) / 2,
          dw,
          dh,
        );
      } else {
        ctx.fillStyle = '#777777';
        ctx.font = `400 20px ${FONT_FAMILY}`;
        ctx.fillText('(서명)', sx + sc.width / 2, y + sigHeadH + sigBodyH / 2);
      }
    } else {
      ctx.fillStyle = '#111111';
      ctx.font = `500 23px ${FONT_FAMILY}`;
      const lines = wrapText(ctx, sc.value, sc.width - 28, 2);
      if (lines.length === 1) {
        ctx.fillText(lines[0], sx + sc.width / 2, y + sigHeadH + sigBodyH / 2);
      } else {
        ctx.fillText(lines[0], sx + sc.width / 2, y + sigHeadH + sigBodyH / 2 - 15);
        ctx.fillText(lines[1], sx + sc.width / 2, y + sigHeadH + sigBodyH / 2 + 15);
      }
    }
    sx += sc.width;
  }
  ctx.beginPath();
  ctx.moveTo(MARGIN_X, y + sigHeadH);
  ctx.lineTo(MARGIN_X + CONTENT_W, y + sigHeadH);
  ctx.stroke();

  // Draw footers on all pages
  const totalPages = pages.length;
  pages.forEach((p, idx) => {
    p.ctx.strokeStyle = '#e0e4e2';
    p.ctx.lineWidth = 1.5;
    p.ctx.beginPath();
    p.ctx.moveTo(MARGIN_X, FOOTER_Y - 14);
    p.ctx.lineTo(MARGIN_X + CONTENT_W, FOOTER_Y - 14);
    p.ctx.stroke();

    p.ctx.fillStyle = '#666666';
    p.ctx.font = `400 18px ${FONT_FAMILY}`;
    p.ctx.textBaseline = 'top';
    p.ctx.textAlign = 'left';
    p.ctx.fillText('말하는 대로, 바이브 코딩 페스타 · 예선 심사 결과표', MARGIN_X, FOOTER_Y);
    p.ctx.textAlign = 'right';
    p.ctx.fillText(`${idx + 1} / ${totalPages}`, MARGIN_X + CONTENT_W, FOOTER_Y);
  });

  const jpegPages = pages.map((p) => {
    const dataUrl = p.canvas.toDataURL('image/jpeg', 0.92);
    const bytes = dataUrlToBytes(dataUrl);
    p.canvas.width = 0;
    p.canvas.height = 0;
    return { bytes, width: PAGE_PX_W, height: PAGE_PX_H };
  });

  const pdfBytes = buildPdfFromJpegs(jpegPages);
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

function safeFilePart(text) {
  return String(text || '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'result';
}

export async function downloadPrelimResultPdf(completion, options = {}) {
  const blob = await renderPrelimResultPdfBlob(completion, options);
  const date = new Date(completion.completedAt || Date.now());
  const kst = new Date((Number.isNaN(date.getTime()) ? Date.now() : date.getTime()) + 9 * 60 * 60 * 1000);
  const stamp = `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
  const panelTag = completion.panel === 'iwest' ? '한국서부발전' : '행정안전부';
  const signerTag = safeFilePart(completion.name || '심사위원');
  const filename = `예선심사결과_${panelTag}_${signerTag}_${stamp}.pdf`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { filename, size: blob.size };
}

/**
 * 1차 심사 집계 또는 최종 심사 집계·수상 결과표를 고해상도 A4 PDF Blob으로 생성합니다.
 */
export async function renderTallyResultPdfBlob(report) {
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* 시스템 폰트 사용 */ }
  }
  const MARGIN_X = 96;
  const CONTENT_W = PAGE_PX_W - MARGIN_X * 2;
  const FOOTER_Y = PAGE_PX_H - 76;
  const MAX_BODY_Y = FOOTER_Y - 54;
  const HEAD_H = 66;
  const ROW_H = 78;
  const isFinal = report.kind === 'final';

  const cols = isFinal ? [
    { key: 'rank', label: '순위', width: 76 },
    { key: 'institution', label: '기관', width: 146 },
    { key: 'work', label: '작품명 · 제출자', width: 394 },
    { key: 'count', label: '평가수', width: 92 },
    { key: 'c0', label: '문제인식\n(40)', width: 118 },
    { key: 'c1', label: '기능구현\n(30)', width: 118 },
    { key: 'c2', label: '완성도\n(20)', width: 110 },
    { key: 'c3', label: '확산성\n(10)', width: 110 },
    { key: 'avg', label: '최종평균\n(100)', width: 132 },
    { key: 'award', label: '수상구분', width: 166 },
  ] : [
    { key: 'rank', label: '순위', width: 82 },
    { key: 'work', label: '작품명 · 제출자', width: 510 },
    { key: 'count', label: '평가수\n(온라인/엑셀)', width: 162 },
    { key: 'c0', label: '문제인식\n(40점)', width: 136 },
    { key: 'c1', label: '기능구현\n(30점)', width: 136 },
    { key: 'c2', label: '완성도\n(20점)', width: 134 },
    { key: 'c3', label: '확산가능성\n(10점)', width: 136 },
    { key: 'avg', label: '환산평균\n(100점)', width: 166 },
  ];

  const rows = Array.isArray(report.rows) ? report.rows : [];
  const recipients = Array.isArray(report.recipients) ? report.recipients : [];
  const pages = [];

  const drawTop = (ctx, first) => {
    let y = 92;
    if (first) {
      ctx.fillStyle = '#1E3932';
      ctx.fillRect(MARGIN_X, y, CONTENT_W, 10);
      y += 38;

      ctx.fillStyle = '#a51e57';
      ctx.font = `700 25px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('말하는 대로, 바이브 코딩 페스타', MARGIN_X, y);
      y += 38;

      ctx.fillStyle = '#111111';
      ctx.font = `700 44px ${FONT_FAMILY}`;
      ctx.fillText(report.title || (isFinal ? '최종 심사 집계 결과표' : '1차 심사 집계 결과표'), MARGIN_X, y);
      y += 66;

      ctx.fillStyle = '#f6f7f6';
      ctx.strokeStyle = '#d4dcd8';
      ctx.lineWidth = 2;
      ctx.fillRect(MARGIN_X, y, CONTENT_W, 96);
      ctx.strokeRect(MARGIN_X, y, CONTENT_W, 96);

      ctx.fillStyle = '#222222';
      ctx.font = `500 21px ${FONT_FAMILY}`;
      ctx.fillText(report.summaryLine || '', MARGIN_X + 24, y + 18);
      ctx.fillStyle = '#4a5550';
      ctx.font = `400 20px ${FONT_FAMILY}`;
      ctx.fillText(
        `단계 상태: ${report.statusLabel || ''}  |  출력 일시: ${formatKst(report.generatedAt)}  |  관리자 테스트 점수 미반영`,
        MARGIN_X + 24, y + 54,
      );
      y += 124;
    } else {
      ctx.fillStyle = '#1E3932';
      ctx.font = `700 25px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${report.title || '심사 집계 결과표'} (계속)`, MARGIN_X, y);
      y += 46;
    }
    return y;
  };

  const drawHead = (ctx, y) => {
    ctx.fillStyle = '#1E3932';
    ctx.fillRect(MARGIN_X, y, CONTENT_W, HEAD_H);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    let x = MARGIN_X;
    for (const col of cols) {
      const parts = col.label.split('\n');
      if (parts.length === 1) {
        ctx.font = `700 19px ${FONT_FAMILY}`;
        ctx.fillText(parts[0], x + col.width / 2, y + HEAD_H / 2);
      } else {
        ctx.font = `700 19px ${FONT_FAMILY}`;
        ctx.fillText(parts[0], x + col.width / 2, y + HEAD_H / 2 - 12);
        ctx.font = `400 16px ${FONT_FAMILY}`;
        ctx.fillText(parts[1], x + col.width / 2, y + HEAD_H / 2 + 14);
      }
      x += col.width;
    }
    return y + HEAD_H;
  };

  const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '—');

  let current = createPageCanvas();
  pages.push(current);
  let y = drawTop(current.ctx, true);
  y = drawHead(current.ctx, y);

  rows.forEach((row, idx) => {
    if (y + ROW_H > MAX_BODY_Y) {
      current = createPageCanvas();
      pages.push(current);
      y = drawTop(current.ctx, false);
      y = drawHead(current.ctx, y);
    }
    const { ctx } = current;
    ctx.fillStyle = idx % 2 === 1 ? '#f9fbfa' : '#ffffff';
    ctx.fillRect(MARGIN_X, y, CONTENT_W, ROW_H);
    ctx.strokeStyle = '#d4dcd8';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(MARGIN_X, y, CONTENT_W, ROW_H);

    let x = MARGIN_X;
    ctx.textBaseline = 'middle';
    for (let c = 0; c < cols.length; c += 1) {
      const col = cols[c];
      if (c > 0) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + ROW_H);
        ctx.stroke();
      }
      if (col.key === 'rank') {
        ctx.fillStyle = '#1E3932';
        ctx.font = `700 22px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(row.rank ? `${row.rank}위` : '—', x + col.width / 2, y + ROW_H / 2);
      } else if (col.key === 'institution') {
        ctx.fillStyle = '#222222';
        ctx.font = `500 19px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(row.institution || '—', x + col.width / 2, y + ROW_H / 2);
      } else if (col.key === 'work') {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#111111';
        ctx.font = `700 20px ${FONT_FAMILY}`;
        const titleLines = wrapText(ctx, row.title || '', col.width - 24, 1);
        ctx.fillText(titleLines[0], x + 12, y + ROW_H / 2 - 14);
        ctx.fillStyle = '#555555';
        ctx.font = `400 18px ${FONT_FAMILY}`;
        const sub = `${row.authorName || ''}${!isFinal && row.institution ? ` · ${row.institution}` : ''}`;
        ctx.fillText(wrapText(ctx, sub, col.width - 24, 1)[0], x + 12, y + ROW_H / 2 + 16);
      } else if (col.key === 'count') {
        ctx.fillStyle = '#222222';
        ctx.font = `500 19px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        const label = isFinal
          ? `${row.scoreCount ?? 0}건`
          : `${row.scoreCount ?? 0}건 (${row.onlineCount ?? 0}/${row.manualCount ?? 0})`;
        ctx.fillText(label, x + col.width / 2, y + ROW_H / 2);
      } else if (col.key === 'avg') {
        ctx.fillStyle = '#a51e57';
        ctx.font = `700 22px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(row.average != null ? `${fmtNum(row.average)}점` : '—', x + col.width / 2, y + ROW_H / 2);
      } else if (col.key === 'award') {
        ctx.fillStyle = row.awardName ? '#1E3932' : '#666666';
        ctx.font = `700 20px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(row.awardName || '—', x + col.width / 2, y + ROW_H / 2);
      } else {
        const ci = Number(col.key.slice(1));
        ctx.fillStyle = '#222222';
        ctx.font = `500 19px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.fillText(fmtNum(row.criterionAverages?.[ci]), x + col.width / 2, y + ROW_H / 2);
      }
      x += col.width;
    }
    y += ROW_H;
  });

  if (recipients.length) {
    const recHeadH = 54;
    const recRowH = 62;
    const needed = 64 + recHeadH + recipients.length * recRowH;
    if (y + needed > MAX_BODY_Y) {
      current = createPageCanvas();
      pages.push(current);
      y = drawTop(current.ctx, false) + 12;
    } else {
      y += 42;
    }
    const { ctx } = current;
    ctx.fillStyle = '#1E3932';
    ctx.font = `700 26px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('수상 결과 요약', MARGIN_X, y);
    y += 42;

    const rCols = [
      { label: '수상 구분', width: 170 },
      { label: '상훈 · 부상', width: 340 },
      { label: '소속 기관', width: 190 },
      { label: '수상자', width: 170 },
      { label: '작품명', width: CONTENT_W - 170 - 340 - 190 - 170 },
    ];
    ctx.fillStyle = '#e9f0ec';
    ctx.fillRect(MARGIN_X, y, CONTENT_W, recHeadH);
    ctx.strokeStyle = '#8fa39a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(MARGIN_X, y, CONTENT_W, recHeadH);
    let rx = MARGIN_X;
    ctx.fillStyle = '#1E3932';
    ctx.font = `700 20px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < rCols.length; i += 1) {
      if (i > 0) { ctx.beginPath(); ctx.moveTo(rx, y); ctx.lineTo(rx, y + recHeadH); ctx.stroke(); }
      ctx.fillText(rCols[i].label, rx + rCols[i].width / 2, y + recHeadH / 2);
      rx += rCols[i].width;
    }
    y += recHeadH;

    recipients.forEach((rec, i) => {
      ctx.fillStyle = i % 2 === 1 ? '#f9fbfa' : '#ffffff';
      ctx.fillRect(MARGIN_X, y, CONTENT_W, recRowH);
      ctx.strokeStyle = '#d4dcd8';
      ctx.strokeRect(MARGIN_X, y, CONTENT_W, recRowH);
      const vals = [rec.awardName, `${rec.certificate} · ${rec.prizeText}`, rec.institution, rec.name, rec.projectTitle];
      let cx = MARGIN_X;
      for (let c = 0; c < rCols.length; c += 1) {
        if (c > 0) { ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx, y + recRowH); ctx.stroke(); }
        ctx.fillStyle = c === 0 ? '#a51e57' : '#111111';
        ctx.font = c === 0 || c === 3 ? `700 19px ${FONT_FAMILY}` : `500 19px ${FONT_FAMILY}`;
        ctx.textAlign = c === 4 ? 'left' : 'center';
        const txt = wrapText(ctx, vals[c] || '', rCols[c].width - 20, 1)[0];
        ctx.fillText(txt, c === 4 ? cx + 10 : cx + rCols[c].width / 2, y + recRowH / 2);
        cx += rCols[c].width;
      }
      y += recRowH;
    });
  }

  if (report.note) {
    y += 22;
    if (y + 36 > MAX_BODY_Y) {
      current = createPageCanvas();
      pages.push(current);
      y = drawTop(current.ctx, false) + 12;
    }
    current.ctx.fillStyle = '#555555';
    current.ctx.font = `400 18px ${FONT_FAMILY}`;
    current.ctx.textAlign = 'left';
    current.ctx.textBaseline = 'top';
    current.ctx.fillText(report.note, MARGIN_X, y);
  }

  const totalPages = pages.length;
  pages.forEach((p, idx) => {
    p.ctx.strokeStyle = '#e0e4e2';
    p.ctx.lineWidth = 1.5;
    p.ctx.beginPath();
    p.ctx.moveTo(MARGIN_X, FOOTER_Y - 14);
    p.ctx.lineTo(MARGIN_X + CONTENT_W, FOOTER_Y - 14);
    p.ctx.stroke();

    p.ctx.fillStyle = '#666666';
    p.ctx.font = `400 18px ${FONT_FAMILY}`;
    p.ctx.textBaseline = 'top';
    p.ctx.textAlign = 'left';
    p.ctx.fillText(`말하는 대로, 바이브 코딩 페스타 · ${report.title || '심사 집계 결과표'}`, MARGIN_X, FOOTER_Y);
    p.ctx.textAlign = 'right';
    p.ctx.fillText(`${idx + 1} / ${totalPages}`, MARGIN_X + CONTENT_W, FOOTER_Y);
  });

  const jpegPages = pages.map((p) => {
    const dataUrl = p.canvas.toDataURL('image/jpeg', 0.92);
    const bytes = dataUrlToBytes(dataUrl);
    p.canvas.width = 0;
    p.canvas.height = 0;
    return { bytes, width: PAGE_PX_W, height: PAGE_PX_H };
  });

  return new Blob([buildPdfFromJpegs(jpegPages)], { type: 'application/pdf' });
}

export async function downloadTallyResultPdf(report, filePrefix = '심사집계결과') {
  const blob = await renderTallyResultPdfBlob(report);
  const date = new Date(report.generatedAt || Date.now());
  const kst = new Date((Number.isNaN(date.getTime()) ? Date.now() : date.getTime()) + 9 * 60 * 60 * 1000);
  const stamp = `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
  const filename = `${safeFilePart(filePrefix)}_${stamp}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { filename, size: blob.size };
}
