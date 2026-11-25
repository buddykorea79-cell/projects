/** 관리자 전용 1차 심사 집계 · 최종 심사 집계 화면 (수동심사 엑셀 양식 다운로드·업로드, 관리자 테스트 격리 표시, PDF/엑셀 결과 출력). */
import { CONFIG } from '../config.js';
import { isAdmin } from '../auth.js';
import { FESTA_RUBRIC as RUBRIC, validFestaScores, validRawFestaScores, deriveRawFestaScores } from '../festa.js';
import { readSheet, buildXlsx } from '../sheet.js';
import { downloadPrelimResultPdf, downloadTallyResultPdf } from '../pdf.js';
import { esc, attr, fmtDate, downloadBlob } from '../utils.js';
import { spinner, emptyState, confirmModal, toastOk, toastErr, stat } from '../ui.js';

const API = String(CONFIG.r2?.apiBase || '/api').replace(/\/$/, '');
const STATUS = { draft: '준비 중', open: '평가 중', closed: '평가 마감' };
const FIRST_PANELS = {
  mois: { label: '행정안전부 1차 심사', institution: '행정안전부' },
  iwest: { label: '한국서부발전 1차 심사', institution: '한국서부발전' },
};

async function api(path, body) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const badge = (status) => `<span class="badge ${status === 'open' ? 'badge--open' : status === 'closed' ? 'badge--closed' : 'badge--soft'}">${esc(STATUS[status] || status)}</span>`;
const totalOf = (scores) => (validFestaScores(scores) ? scores.reduce((a, b) => a + b, 0) : null);
const fmtAvg = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—');

export function adminNavBar(active) {
  const items = [
    { key: 'submissions', href: '#/admin/festa', label: '접수 현황', testid: 'festa-admin-submissions-btn' },
    { key: 'jury', href: '#/admin/festa/jury', label: '심사위원 관리' },
    { key: 'tally-first', href: '#/admin/festa/tally/first', label: '예선 심사 현황', testid: 'festa-tally-first-link' },
    { key: 'prelim-results', href: '#/admin/festa/prelim-results', label: '예선 심사 결과', testid: 'festa-prelim-results-link' },
    { key: 'tally-final', href: '#/admin/festa/tally/final', label: '본선 심사 현황', testid: 'festa-tally-final-link' },
    { key: 'awards', href: '#/admin/festa/awards', label: '수상작 확정·발표', testid: 'jury-awards-link' },
  ];
  return `<div class="row" data-festa-hero-actions style="margin-top:var(--space-3)">${items.map((item) => `<a class="btn btn--ghostDark${item.key === active ? ' is-active' : ''}" href="${item.href}"${item.testid ? ` data-testid="${item.testid}"` : ''}${item.key === active ? ' aria-current="page"' : ''}>${item.label}</a>`).join('')}</div>`;
}

function shell(mount, activeKey, title, subtitle) {
  mount.innerHTML = `<section class="band festa-hero"><div class="wrap">
    <p class="crumb"><a href="#/admin/festa" style="color:inherit">접수 현황</a><span>/</span>${esc(title)}</p>
    <h1 style="font-size:clamp(2.4rem,5vw,3.4rem);color:inherit">${esc(title)}</h1>
    <p style="margin-top:var(--space-2)">${esc(subtitle)}</p>
    ${adminNavBar(activeKey)}
  </div></section><section class="section"><div class="wrap festa-jury fj-stack" data-tally-root>${spinner()}</div></section>`;
  return mount.querySelector('[data-tally-root]');
}

/* ------------------------------------------- 수동심사 엑셀 양식·파싱 -- */

function downloadManualTemplate(panelKey, panelLabel, entries) {
  const isPrelim = panelKey !== 'final';
  const headers = isPrelim
    ? ['접수번호', '작품명', '심사위원명', '심사위원이메일', '문제인식(1~10)', '기능구현수준(1~10)', '완성도(1~10)', '확산가능성(1~10)']
    : ['접수번호', '작품명', '평가자명', '평가자이메일', '문제인식(0~40)', '기능구현수준(0~30)', '완성도(0~20)', '확산가능성(0~10)'];

  const body = entries.map((entry) => [entry.id, entry.title, '', '', '', '', '', '']);
  const guideRows = isPrelim ? [
    ['항목', '작성 안내'],
    ['접수번호', '자동 입력된 값을 변경하지 마세요. (작품 매칭 기준)'],
    ['작품명', '참고용입니다.'],
    ['심사위원명', '필수 입력 (예: 홍길동). 여러 심사위원의 결과를 함께 올리려면 작품 행을 아래에 복사해 심사위원명을 다르게 입력하세요.'],
    ['심사위원이메일', '선택 입력 (본인 출품작 중복·자기평가 방지에 사용됩니다). 관리자 이메일은 공식 집계에 반영되지 않습니다.'],
    ['문제인식(1~10)', '1~10 사이 정수 입력 → 업로드 시 ×4 자동 환산 (최대 40점)'],
    ['기능구현수준(1~10)', '1~10 사이 정수 입력 → 업로드 시 ×3 자동 환산 (최대 30점)'],
    ['완성도(1~10)', '1~10 사이 정수 입력 → 업로드 시 ×2 자동 환산 (최대 20점)'],
    ['확산가능성(1~10)', '1~10 사이 정수 입력 → 업로드 시 ×1 자동 환산 (최대 10점)'],
    ['동일 위원 재업로드', '같은 심사위원·같은 작품 점수는 최신 업로드 값으로 덮어씁니다.'],
  ] : [
    ['항목', '작성 안내'],
    ['접수번호', '자동 입력된 값을 변경하지 마세요. (본선 6작품 식별 기준)'],
    ['작품명', '참고용입니다.'],
    ['평가자명', '필수 입력 (예: 김심사). 여러 평가자를 입력하려면 6작품 행을 아래에 복사해 평가자명을 다르게 적어 주세요.'],
    ['평가자이메일', '선택 입력 (본인 출품작 자기평가 방지용). 관리자 이메일은 공식 집계에 반영되지 않습니다.'],
    ['문제인식(0~40)', '0~40 사이 정수 입력'],
    ['기능구현수준(0~30)', '0~30 사이 정수 입력'],
    ['완성도(0~20)', '0~20 사이 정수 입력'],
    ['확산가능성(0~10)', '0~10 사이 정수 입력'],
  ];

  const blob = buildXlsx([
    { name: '수동심사_입력', rows: [headers, ...body] },
    { name: '작성안내', rows: guideRows },
  ]);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  downloadBlob(blob, `수동심사양식_${panelLabel.replace(/\s+/g, '_')}_${stamp}.xlsx`);
}

function normHeader(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[()（）\-_·]/g, '').toLowerCase();
}

function findColumn(headers, patterns, fallback) {
  const idx = headers.findIndex((h) => patterns.some((p) => h.includes(p)));
  return idx >= 0 ? idx : fallback;
}

function parseIntCell(raw) {
  const str = String(raw ?? '').trim();
  if (!str || !/^-?\d+$/.test(str)) return null;
  return Number(str);
}

/**
 * 업로드된 엑셀/CSV 2차원 배열을 수동심사 행으로 파싱·검증합니다.
 */
export function parseManualSheetRows(sheetRows, panelKey, targetEntries) {
  if (!Array.isArray(sheetRows) || sheetRows.length < 2) {
    return { valid: [], errors: ['헤더 행과 1건 이상의 점수 행이 필요합니다.'] };
  }
  const isPrelim = panelKey !== 'final';
  const headers = sheetRows[0].map(normHeader);
  const idxEntryId = findColumn(headers, ['접수번호', 'entryid', '작품번호', '작품id'], 0);
  const idxTitle = findColumn(headers, ['작품명', 'title'], 1);
  const idxJudgeName = findColumn(headers, ['심사위원명', '평가자명', '심사위원', '평가자', '성명', '이름'], 2);
  const idxJudgeEmail = findColumn(headers, ['이메일', 'email'], 3);
  const idxC0 = findColumn(headers, ['문제인식'], 4);
  const idxC1 = findColumn(headers, ['기능구현'], 5);
  const idxC2 = findColumn(headers, ['완성도'], 6);
  const idxC3 = findColumn(headers, ['확산'], 7);

  const byId = new Map(targetEntries.map((e) => [e.id, e]));
  const byTitle = new Map();
  for (const e of targetEntries) {
    const k = String(e.title || '').trim();
    if (k && !byTitle.has(k)) byTitle.set(k, e);
  }

  const valid = [];
  const errors = [];

  for (let r = 1; r < sheetRows.length; r += 1) {
    const row = sheetRows[r] || [];
    const lineNo = r + 1;
    const rawId = String(row[idxEntryId] ?? '').trim();
    const rawTitle = String(row[idxTitle] ?? '').trim();
    const judgeName = String(row[idxJudgeName] ?? '').trim();
    const judgeEmail = String(row[idxJudgeEmail] ?? '').trim();
    const scoreCells = [row[idxC0], row[idxC1], row[idxC2], row[idxC3]];
    const allScoreBlank = scoreCells.every((c) => String(c ?? '').trim() === '');

    // 양식에서 아직 점수를 입력하지 않은 빈 템플릿 행은 자동으로 건너뜁니다.
    if (!judgeName && allScoreBlank) continue;

    const entry = byId.get(rawId) || (rawTitle ? byTitle.get(rawTitle) : null);
    if (!entry) {
      errors.push(`${lineNo}행: 평가 대상 작품(${rawId || rawTitle || '비어 있음'})을 찾을 수 없습니다.`);
      continue;
    }
    if (!judgeName) {
      errors.push(`${lineNo}행 (${entry.title}): 심사위원명/평가자명이 비어 있습니다.`);
      continue;
    }
    const nums = scoreCells.map(parseIntCell);
    if (nums.some((n) => n === null)) {
      errors.push(`${lineNo}행 (${entry.title} · ${judgeName}): 4개 평가 항목에 정수를 모두 입력해 주세요.`);
      continue;
    }
    if (isPrelim) {
      if (!validRawFestaScores(nums)) {
        errors.push(`${lineNo}행 (${entry.title} · ${judgeName}): 1차 예선 각 항목은 1~10 사이 정수로 입력해야 합니다. (입력: ${nums.join(', ')})`);
        continue;
      }
      valid.push({ entryId: entry.id, entryTitle: entry.title, judgeName, judgeEmail, rawScores: nums });
    } else {
      if (!validFestaScores(nums)) {
        errors.push(`${lineNo}행 (${entry.title} · ${judgeName}): 최종 심사 배점(40·30·20·10) 범위의 정수로 입력해야 합니다. (입력: ${nums.join(', ')})`);
        continue;
      }
      valid.push({ entryId: entry.id, entryTitle: entry.title, judgeName, judgeEmail, scores: nums });
    }
  }

  if (!valid.length && !errors.length) {
    errors.push('점수가 입력된 행이 없습니다. 심사위원명과 4개 항목 점수를 입력한 뒤 업로드해 주세요.');
  }
  return { valid, errors };
}

function adminTestNoticeHtml(panel) {
  const tests = Array.isArray(panel.adminTests) ? panel.adminTests : [];
  if (!tests.length) {
    return `<p class="notice notice--info" data-testid="tally-admin-rule"><strong>운영 원칙:</strong> 관리자는 심사 화면에서 <strong>테스트 중</strong> 모드로만 점검할 수 있으며, 관리자 테스트 점수는 공식 심사 집계에 반영되지 않습니다. 실제 심사는 심사위원(온라인 또는 수동심사 엑셀 업로드) 결과만 집계됩니다.</p>`;
  }
  return `<section class="notice notice--warn fj-test-banner" data-testid="tally-test-notice">
    <div class="fj-head" style="width:100%">
      <div>
        <span class="badge badge--gold">테스트 중</span>
        <strong style="margin-left:8px">관리자 테스트 기록 ${tests.length}건 감지됨 (공식 집계 미반영)</strong>
        <p class="field__hint" style="margin-top:4px">${tests.map((t) => `${esc(t.name)} (${t.scoredCount}작품 테스트${t.completed ? ' · 완료 테스트' : ''})`).join(', ')} — 아래 공식 집계표에는 포함되지 않았습니다.</p>
      </div>
      <button type="button" class="btn btn--outline btn--sm" data-clear-admin-test>테스트 기록 초기화</button>
    </div>
  </section>`;
}

function manualExcelSectionHtml(panel, entries, uploadState) {
  const locked = panel.status === 'closed';
  const manualJudges = Array.isArray(panel.manualJudges) ? panel.manualJudges : [];
  const isPrelim = panel.key !== 'final';
  return `<section class="card fj-stack" data-testid="manual-excel-card">
    <div class="fj-head">
      <div>
        <h3 style="font-size:2rem">📥 수동심사 엑셀 양식 다운로드 · 업로드 반영</h3>
        <p class="field__hint">${isPrelim
          ? '오프라인·수동으로 진행한 1차 심사 점수(항목별 1~10점)를 엑셀 양식에 작성해 업로드하면 심사기준(40·30·20·10)으로 자동 환산되어 공식 집계에 반영됩니다.'
          : '오프라인·수동으로 진행한 최종 심사 점수(배점 40·30·20·10)를 엑셀 양식에 작성해 업로드하면 최종 심사 집계와 수상 계산에 바로 반영됩니다.'}</p>
      </div>
      <button type="button" class="btn btn--outline" data-testid="manual-template-download" ${entries.length ? '' : 'disabled'}>엑셀 양식 다운로드 (.xlsx)</button>
    </div>
    ${!entries.length ? '<p class="notice notice--info">먼저 [심사위원·평가 대상 관리]에서 평가 대상 작품을 선택·저장해야 엑셀 양식을 내려받을 수 있습니다.</p>' : ''}
    ${locked ? '<p class="notice notice--info">이 단계는 평가가 마감되어 수동심사 엑셀 업로드·삭제가 잠겨 있습니다.</p>' : `<div class="fj-manual-upload">
      <div class="fj-head">
        <label class="field grow" style="margin:0">
          <span class="field__label">수동심사 엑셀 파일 선택 (.xlsx 또는 .csv)</span>
          <input class="input" type="file" accept=".xlsx,.csv,.tsv" data-testid="manual-excel-input" ${entries.length ? '' : 'disabled'} />
        </label>
        <label class="field" style="margin:0;min-width:190px">
          <span class="field__label">반영 방식</span>
          <select class="select" data-testid="manual-import-mode">
            <option value="merge" ${uploadState.mode === 'merge' ? 'selected' : ''}>기존 수동점수에 추가·갱신</option>
            <option value="replace" ${uploadState.mode === 'replace' ? 'selected' : ''}>기존 수동점수 전체 교체</option>
          </select>
        </label>
      </div>
      ${uploadState.fileName ? `<div class="card card--flat fj-stack" style="margin-top:var(--space-3)" data-testid="manual-preview">
        <div class="fj-head">
          <div>
            <strong>파일 확인: ${esc(uploadState.fileName)}</strong>
            <p class="field__hint">정상 ${uploadState.valid.length}건 · 오류 ${uploadState.errors.length}건</p>
          </div>
          <div class="fj-actions">
            <button type="button" class="btn btn--primary btn--sm" data-testid="manual-import-submit" ${uploadState.valid.length && !uploadState.errors.length ? '' : 'disabled'}>집계에 반영하기 (${uploadState.valid.length}건)</button>
            <button type="button" class="btn btn--quiet btn--sm" data-manual-preview-clear>취소</button>
          </div>
        </div>
        ${uploadState.errors.length ? `<div class="notice notice--err"><div><strong>업로드 전 수정이 필요합니다</strong><ul style="margin-top:6px;padding-left:1.8rem;list-style:disc">${uploadState.errors.slice(0, 10).map((e) => `<li>${esc(e)}</li>`).join('')}${uploadState.errors.length > 10 ? `<li>외 ${uploadState.errors.length - 10}건</li>` : ''}</ul></div></div>` : ''}
        ${uploadState.valid.length ? `<div class="fj-table-wrap"><table class="fj-table"><thead><tr><th>작품</th><th>심사위원</th><th>이메일</th>${RUBRIC.map((r) => `<th>${r.name}</th>`).join('')}</tr></thead><tbody>${uploadState.valid.slice(0, 20).map((row) => `<tr><td>${esc(row.entryTitle)}</td><td>${esc(row.judgeName)}</td><td>${esc(row.judgeEmail || '—')}</td>${(row.rawScores || row.scores).map((n, i) => `<td>${row.rawScores ? `${n} (환산 ${n * RUBRIC[i].weight})` : `${n}`}</td>`).join('')}</tr>`).join('')}${uploadState.valid.length > 20 ? `<tr><td colspan="7" class="field__hint">외 ${uploadState.valid.length - 20}건 더 있음</td></tr>` : ''}</tbody></table></div>` : ''}
      </div>` : ''}
    </div>`}
    ${manualJudges.length ? `<div class="fj-stack" style="margin-top:var(--space-2)">
      <div class="fj-head">
        <h4>반영된 수동심사(엑셀) 목록 · ${manualJudges.length}명</h4>
        ${locked ? '' : '<button type="button" class="btn btn--danger btn--sm" data-manual-clear-all>수동심사 전체 삭제</button>'}
      </div>
      <div class="fj-table-wrap"><table class="fj-table" data-testid="manual-judges-table"><thead><tr><th>심사위원명</th><th>이메일</th><th>반영 작품 수</th><th>업로드 일시</th>${locked ? '' : '<th>관리</th>'}</tr></thead><tbody>${manualJudges.map((j) => `<tr>
        <td><strong>${esc(j.name)}</strong> <span class="badge badge--soft">엑셀</span></td>
        <td>${esc(j.email || '—')}</td>
        <td>${j.scoredCount}건</td>
        <td>${j.importedAt ? esc(fmtDate(j.importedAt, true)) : '—'}</td>
        ${locked ? '' : `<td><button type="button" class="btn btn--quiet btn--sm" data-manual-clear-one="${attr(j.id)}">삭제</button></td>`}
      </tr>`).join('')}</tbody></table></div>
    </div>` : '<p class="fj-note">아직 업로드된 수동심사(엑셀) 점수가 없습니다.</p>'}
  </section>`;
}

function bindManualExcelHandlers(root, panel, targetEntries, uploadState, refresh) {
  root.querySelector('[data-testid="manual-template-download"]')?.addEventListener('click', () => {
    downloadManualTemplate(panel.key, panel.label, targetEntries);
    toastOk('수동심사 엑셀 양식을 내려받았습니다.');
  });
  root.querySelector('[data-testid="manual-import-mode"]')?.addEventListener('change', (e) => {
    uploadState.mode = e.target.value;
  });
  root.querySelector('[data-testid="manual-excel-input"]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const sheetRows = await readSheet(file);
      const parsed = parseManualSheetRows(sheetRows, panel.key, targetEntries);
      uploadState.fileName = file.name;
      uploadState.valid = parsed.valid;
      uploadState.errors = parsed.errors;
      refresh(false);
    } catch (error) {
      toastErr(`엑셀 파일을 읽지 못했습니다: ${error.message}`);
    }
  });
  root.querySelector('[data-manual-preview-clear]')?.addEventListener('click', () => {
    uploadState.fileName = '';
    uploadState.valid = [];
    uploadState.errors = [];
    refresh(false);
  });
  root.querySelector('[data-testid="manual-import-submit"]')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (!uploadState.valid.length || uploadState.errors.length || btn.disabled) return;
    btn.disabled = true;
    try {
      const res = await api('/festa/jury/manual-import', {
        panel: panel.key,
        mode: uploadState.mode,
        rows: uploadState.valid.map(({ entryId, judgeName, judgeEmail, rawScores, scores }) => ({
          entryId, judgeName, judgeEmail,
          ...(rawScores ? { rawScores } : { scores }),
        })),
      });
      uploadState.fileName = '';
      uploadState.valid = [];
      uploadState.errors = [];
      toastOk(`수동심사 점수 ${res.importedCount}건을 집계에 반영했습니다.`);
      await refresh(true);
    } catch (error) {
      toastErr(error.message);
      btn.disabled = false;
    }
  });
  root.querySelector('[data-manual-clear-all]')?.addEventListener('click', async () => {
    if (!await confirmModal({ title: '수동심사 점수를 모두 삭제할까요?', body: '이 단계에 엑셀로 업로드한 수동심사 점수가 모두 제거됩니다. 온라인 심사위원 점수는 유지됩니다.', confirmLabel: '전체 삭제', danger: true })) return;
    try { await api('/festa/jury/manual-clear', { panel: panel.key }); toastOk('수동심사 점수를 삭제했습니다.'); await refresh(true); }
    catch (error) { toastErr(error.message); }
  });
  root.querySelectorAll('[data-manual-clear-one]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!await confirmModal({ title: '이 수동심사 위원의 점수를 삭제할까요?', body: '선택한 수동심사 위원의 엑셀 점수가 집계에서 제외됩니다.', confirmLabel: '삭제', danger: true })) return;
    try { await api('/festa/jury/manual-clear', { panel: panel.key, judgeId: btn.dataset.manualClearOne }); toastOk('삭제했습니다.'); await refresh(true); }
    catch (error) { toastErr(error.message); }
  }));
  root.querySelector('[data-clear-admin-test]')?.addEventListener('click', async () => {
    if (!await confirmModal({ title: '관리자 테스트 기록을 초기화할까요?', body: '테스트 중 저장한 관리자 점수와 완료 기록을 삭제합니다. 공식 집계에는 영향이 없습니다.', confirmLabel: '테스트 초기화' })) return;
    try { await api('/festa/jury/test-clear', { panel: panel.key, all: true }); toastOk('관리자 테스트 기록을 초기화했습니다.'); await refresh(true); }
    catch (error) { toastErr(error.message); }
  });
}

/* ------------------------------------------- 예선 심사 현황 (수동집계 포함) -- */

function computeFirstRanked(panel, entries, selectedPanel) {
  const targetEntries = panel.entryIds.map((id) => entries.find((e) => e.id === id)).filter(Boolean);
  const ranked = targetEntries.map((entry) => {
    const r = (panel.results || []).find((x) => x.entryId === entry.id) || {};
    return {
      entryId: entry.id,
      title: entry.title,
      authorName: entry.author?.name || '',
      institution: entry.institution || FIRST_PANELS[selectedPanel].institution,
      scoreCount: r.scoreCount || 0,
      onlineCount: r.onlineCount || 0,
      manualCount: r.manualCount || 0,
      criterionAverages: r.criterionAverages || null,
      average: typeof r.average === 'number' && Number.isFinite(r.average) ? r.average : null,
    };
  }).sort((a, b) => {
    if ((b.average ?? -1) !== (a.average ?? -1)) return (b.average ?? -1) - (a.average ?? -1);
    for (let i = 0; i < 4; i += 1) {
      const diff = (b.criterionAverages?.[i] ?? -1) - (a.criterionAverages?.[i] ?? -1);
      if (diff !== 0) return diff;
    }
    return a.title.localeCompare(b.title);
  });
  let prevAvg = null;
  let rankNum = 0;
  ranked.forEach((row, i) => {
    if (row.average === null) { row.rank = null; return; }
    if (row.average !== prevAvg) { rankNum = i + 1; prevAvg = row.average; }
    row.rank = rankNum;
  });
  return { targetEntries, ranked };
}

export async function festaFirstTallyView(mount) {
  const root = shell(mount, 'tally-first', '예선 심사 현황', '행정안전부·한국서부발전 예선 심사 진행 현황을 확인하고 수동심사 엑셀을 집계에 반영합니다.');
  if (!isAdmin()) { root.innerHTML = '<p class="notice notice--err">관리자만 이용할 수 있습니다.</p>'; return; }
  let selectedPanel = 'mois';
  let scoreMode = 'converted';
  let cachedData = null;
  const uploadState = { fileName: '', mode: 'merge', valid: [], errors: [] };

  const render = async (reload = true) => {
    if (reload || !cachedData) cachedData = await api('/festa/jury/admin');
    if (!root.isConnected) return;
    const entries = Array.isArray(cachedData.entries) ? cachedData.entries : [];
    const panel = (cachedData.panels || []).find((p) => p.key === selectedPanel)
      || { key: selectedPanel, label: FIRST_PANELS[selectedPanel].label, status: 'draft', entryIds: [], judges: [], manualJudges: [], adminTests: [], scores: [], results: [] };
    const { targetEntries } = computeFirstRanked(panel, entries, selectedPanel);

    const completedJudges = panel.judges.filter((j) => j.completed).length;
    const totalScores = (panel.scores || []).length;

    const judgeNameOf = (row) => {
      if (row.judgeName) return row.judgeName;
      return panel.judges.find((j) => j.id === row.judgeId)?.name
        || (panel.manualJudges || []).find((j) => j.id === row.judgeId)?.name
        || '심사위원';
    };

    const formatCell = (row, idx) => {
      const conv = validFestaScores(row.scores) ? row.scores[idx] : null;
      const raw = validRawFestaScores(row.rawScores) ? row.rawScores[idx] : deriveRawFestaScores(row.scores)?.[idx] ?? null;
      if (scoreMode === 'raw') return raw != null ? `${raw} / 10` : '—';
      if (scoreMode === 'both' && raw != null && conv != null) return `${raw} → <strong>${conv}점</strong>`;
      return conv != null ? `${conv}점` : '—';
    };

    root.innerHTML = `<div class="fj-head">
        <div class="fj-tabs" role="tablist" aria-label="예선 심사 기관 선택">
          <button type="button" class="btn btn--outline" role="tab" aria-selected="${selectedPanel === 'mois'}" data-first-panel="mois">행정안전부 예선 현황</button>
          <button type="button" class="btn btn--outline" role="tab" aria-selected="${selectedPanel === 'iwest'}" data-first-panel="iwest">한국서부발전 예선 현황</button>
        </div>
        <div class="fj-actions">
          ${badge(panel.status)}
          <a class="btn btn--outline btn--sm" href="#/festa/prelim/${attr(selectedPanel)}">심사 화면 테스트</a>
          <a class="btn btn--primary btn--sm" href="#/admin/festa/prelim-results">예선 심사 결과 보기 →</a>
          <button type="button" class="btn btn--quiet btn--sm" data-tally-refresh>새로고침</button>
        </div>
      </div>
      ${adminTestNoticeHtml(panel)}
      <div class="stat-row">
        ${stat(`${targetEntries.length}건`, '평가 대상 작품')}
        ${stat(`${completedJudges} / ${panel.judges.length}명`, '온라인 심사 완료')}
        ${stat(`${(panel.manualJudges || []).length}명`, '수동심사(엑셀) 위원')}
        ${stat(`${totalScores}건`, '총 집계 평가 수')}
      </div>
      <section class="card fj-stack" data-testid="first-tally-judges">
        <div class="fj-head">
          <div>
            <h2 class="page-title" style="font-size:2.1rem">${esc(FIRST_PANELS[selectedPanel].label)} 위원별 진행 현황</h2>
            <p class="field__hint">온라인 심사위원의 평가 진행률과 최종 서명 완료 여부를 확인합니다.</p>
          </div>
          <a class="btn btn--outline btn--sm" href="#/admin/festa/jury">심사위원 관리로 이동</a>
        </div>
        ${panel.judges.length ? `<div class="fj-table-wrap"><table class="fj-table">
          <thead><tr><th>기관명</th><th>심사위원</th><th>이메일</th><th>평가 진행</th><th>서명 완료</th><th>결과 PDF</th></tr></thead>
          <tbody>${panel.judges.map((j) => `<tr>
            <td><span class="badge badge--soft">${esc(j.institution || FIRST_PANELS[selectedPanel].institution)}</span></td>
            <td><strong>${esc(j.name)}</strong></td>
            <td>${esc(j.email || '')}</td>
            <td>${j.scoredCount ?? 0} / ${j.eligibleCount ?? targetEntries.length}건</td>
            <td>${j.completed ? `<span class="badge badge--open">✓ 완료</span><br><span class="field__hint">${esc(fmtDate(j.completedAt, true))}</span>` : '<span class="badge badge--soft">진행 중</span>'}</td>
            <td>${j.completed ? `<button type="button" class="btn btn--outline btn--sm" data-judge-signed-pdf="${attr(j.id)}">📄 서명 PDF</button>` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<p class="fj-note">등록된 온라인 심사위원이 없습니다. 아래 수동심사 엑셀을 업로드하거나 [심사위원 관리]에서 위원을 등록하세요.</p>'}
      </section>
      ${manualExcelSectionHtml(panel, targetEntries, uploadState)}
      <section class="card fj-stack">
        <div class="fj-head">
          <div>
            <h3 style="font-size:2rem">심사위원별 상세 점수 내역</h3>
            <p class="field__hint">온라인 심사위원과 수동심사(엑셀)로 반영된 전체 점수를 확인합니다.</p>
          </div>
          <div class="fj-mode-bar" role="group" aria-label="점수 표시 변환">
            <button type="button" class="btn btn--outline btn--sm ${scoreMode === 'converted' ? 'is-selected' : ''}" data-tally-mode="converted">환산점수 (100점)</button>
            <button type="button" class="btn btn--outline btn--sm ${scoreMode === 'raw' ? 'is-selected' : ''}" data-tally-mode="raw">원점수 (1~10점)</button>
            <button type="button" class="btn btn--outline btn--sm ${scoreMode === 'both' ? 'is-selected' : ''}" data-tally-mode="both">원점수 → 환산점수</button>
          </div>
        </div>
        ${panel.scores.length ? `<div class="fj-table-wrap"><table class="fj-table" data-testid="first-tally-scores">
          <thead><tr><th>구분</th><th>심사위원</th><th>작품</th>${RUBRIC.map((r) => `<th>${r.name}</th>`).join('')}<th>합계</th></tr></thead>
          <tbody>${panel.scores.map((row) => `<tr>
            <td>${row.source === 'excel' ? '<span class="badge badge--soft">수동(엑셀)</span>' : '<span class="badge badge--open">온라인</span>'}</td>
            <td>${esc(judgeNameOf(row))}</td>
            <td>${esc(entries.find((e) => e.id === row.entryId)?.title || row.entryId)}</td>
            ${[0, 1, 2, 3].map((i) => `<td>${formatCell(row, i)}</td>`).join('')}
            <td><strong>${totalOf(row.scores) ?? '—'}점</strong></td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<p class="fj-note">아직 저장된 평가 점수가 없습니다.</p>'}
      </section>`;

    root.querySelectorAll('[data-first-panel]').forEach((btn) => btn.addEventListener('click', () => {
      selectedPanel = btn.dataset.firstPanel;
      uploadState.fileName = ''; uploadState.valid = []; uploadState.errors = [];
      render(false);
    }));
    root.querySelectorAll('[data-tally-mode]').forEach((btn) => btn.addEventListener('click', () => {
      scoreMode = btn.dataset.tallyMode;
      render(false);
    }));
    root.querySelector('[data-tally-refresh]').addEventListener('click', () => render(true).catch((e) => toastErr(e.message)));
    bindManualExcelHandlers(root, panel, targetEntries, uploadState, render);

    root.querySelectorAll('[data-judge-signed-pdf]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api(`/festa/jury/admin/completion?panel=${encodeURIComponent(selectedPanel)}&judgeId=${encodeURIComponent(btn.dataset.judgeSignedPdf)}`);
        await downloadPrelimResultPdf(res.completion, { scoreMode: 'both' });
        toastOk('심사위원 서명 PDF를 다운로드했습니다.');
      } catch (error) { toastErr(error.message); }
      finally { btn.disabled = false; }
    }));
  };

  try { await render(true); }
  catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err">${esc(error.message)}</p>`; }
}

/* ----------------------------------------------------- 예선 심사 결과 -- */

export async function festaPrelimResultsView(mount) {
  const root = shell(mount, 'prelim-results', '예선 심사 결과', '기관별 예선 심사 최종 집계 순위와 환산점수 결과를 확인하고 PDF·엑셀로 내려받습니다.');
  if (!isAdmin()) { root.innerHTML = '<p class="notice notice--err">관리자만 이용할 수 있습니다.</p>'; return; }
  let selectedPanel = 'mois';
  let cachedData = null;

  const render = async (reload = true) => {
    if (reload || !cachedData) cachedData = await api('/festa/jury/admin');
    if (!root.isConnected) return;
    const entries = Array.isArray(cachedData.entries) ? cachedData.entries : [];
    const panel = (cachedData.panels || []).find((p) => p.key === selectedPanel)
      || { key: selectedPanel, label: FIRST_PANELS[selectedPanel].label, status: 'draft', entryIds: [], judges: [], manualJudges: [], adminTests: [], scores: [], results: [] };
    const { targetEntries, ranked } = computeFirstRanked(panel, entries, selectedPanel);
    const scoredRanked = ranked.filter((r) => r.average !== null);
    const topAvg = scoredRanked.length ? `${scoredRanked[0].average.toFixed(1)}점` : '—';
    const overallAvg = scoredRanked.length
      ? `${(scoredRanked.reduce((s, r) => s + r.average, 0) / scoredRanked.length).toFixed(1)}점`
      : '—';
    const totalScores = (panel.scores || []).length;
    const judgeNameOf = (row) => (
      row.judgeName
      || panel.judges.find((j) => j.id === row.judgeId)?.name
      || (panel.manualJudges || []).find((j) => j.id === row.judgeId)?.name
      || '심사위원'
    );

    root.innerHTML = `<div class="fj-head">
        <div class="fj-tabs" role="tablist" aria-label="예선 결과 기관 선택">
          <button type="button" class="btn btn--outline" role="tab" aria-selected="${selectedPanel === 'mois'}" data-result-panel="mois">행정안전부 예선 결과</button>
          <button type="button" class="btn btn--outline" role="tab" aria-selected="${selectedPanel === 'iwest'}" data-result-panel="iwest">한국서부발전 예선 결과</button>
        </div>
        <div class="fj-actions">
          ${badge(panel.status)}
          <a class="btn btn--outline btn--sm" href="#/admin/festa/tally/first">예선 심사 현황·엑셀 반영</a>
          <button type="button" class="btn btn--quiet btn--sm" data-results-refresh>새로고침</button>
        </div>
      </div>
      ${adminTestNoticeHtml(panel)}
      <div class="stat-row">
        ${stat(`${targetEntries.length}건`, '평가 대상 작품')}
        ${stat(`${totalScores}건`, '총 반영 평가 수')}
        ${stat(topAvg, '최고 환산 평균')}
        ${stat(overallAvg, '전체 평균')}
      </div>
      <section class="card fj-stack" data-testid="prelim-results-ranking">
        <div class="fj-head">
          <div>
            <h2 class="page-title" style="font-size:2.2rem">${esc(FIRST_PANELS[selectedPanel].label)} 최종 집계 순위</h2>
            <p class="field__hint">온라인 심사위원과 수동심사(엑셀) 점수가 통합 반영된 공식 예선 심사 결과입니다. (관리자 테스트 점수 제외)</p>
          </div>
          <div class="fj-actions">
            <button type="button" class="btn btn--primary" data-testid="first-tally-pdf" ${ranked.length ? '' : 'disabled'}>📄 예선 결과 PDF 다운로드</button>
            <button type="button" class="btn btn--outline" data-testid="first-tally-xlsx" ${ranked.length ? '' : 'disabled'}>📊 예선 결과 엑셀 다운로드</button>
          </div>
        </div>
        ${ranked.length ? `<div class="fj-table-wrap"><table class="fj-table">
          <thead><tr><th>순위</th><th>작품명 · 제출자</th><th>평가수 (온라인/엑셀)</th>${RUBRIC.map((r) => `<th>${r.name} (${r.max})</th>`).join('')}<th>환산 평균 (100)</th></tr></thead>
          <tbody>${ranked.map((row) => `<tr>
            <td>${row.rank ? `<span class="badge ${row.rank <= 3 ? 'badge--gold' : 'badge--soft'}">${row.rank}위</span>` : '—'}</td>
            <td><strong>${esc(row.title)}</strong><br><span class="field__hint">${esc(row.authorName)} · ${esc(row.institution)}</span></td>
            <td>${row.scoreCount}건 <span class="field__hint">(${row.onlineCount}/${row.manualCount})</span></td>
            ${[0, 1, 2, 3].map((i) => `<td>${fmtAvg(row.criterionAverages?.[i])}</td>`).join('')}
            <td><strong>${row.average !== null ? `${row.average.toFixed(1)}점` : '—'}</strong></td>
          </tr>`).join('')}</tbody>
        </table></div>` : emptyState({ title: '집계할 예선 작품이 없습니다', body: '[심사위원 관리]에서 예선 대상 작품을 먼저 선택해 주세요.' })}
        ${panel.judges.some((j) => j.completed) ? `<div class="card card--flat fj-stack">
          <h4>심사위원별 서명 결과표 PDF</h4>
          <div class="fj-actions">${panel.judges.filter((j) => j.completed).map((j) => `<button type="button" class="btn btn--outline btn--sm" data-judge-signed-pdf="${attr(j.id)}">📄 ${esc(j.name)} 서명 결과 PDF</button>`).join('')}</div>
        </div>` : ''}
      </section>`;

    root.querySelectorAll('[data-result-panel]').forEach((btn) => btn.addEventListener('click', () => {
      selectedPanel = btn.dataset.resultPanel;
      render(false);
    }));
    root.querySelector('[data-results-refresh]').addEventListener('click', () => render(true).catch((e) => toastErr(e.message)));
    root.querySelector('[data-clear-admin-test]')?.addEventListener('click', async () => {
      if (!await confirmModal({ title: '관리자 테스트 기록을 초기화할까요?', body: '테스트 중 저장한 관리자 점수를 삭제합니다. 공식 집계에는 영향이 없습니다.', confirmLabel: '테스트 초기화' })) return;
      try { await api('/festa/jury/test-clear', { panel: selectedPanel, all: true }); toastOk('관리자 테스트 기록을 초기화했습니다.'); await render(true); }
      catch (error) { toastErr(error.message); }
    });
    root.querySelectorAll('[data-judge-signed-pdf]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api(`/festa/jury/admin/completion?panel=${encodeURIComponent(selectedPanel)}&judgeId=${encodeURIComponent(btn.dataset.judgeSignedPdf)}`);
        await downloadPrelimResultPdf(res.completion, { scoreMode: 'both' });
        toastOk('심사위원 서명 PDF를 다운로드했습니다.');
      } catch (error) { toastErr(error.message); }
      finally { btn.disabled = false; }
    }));
    root.querySelector('[data-testid="first-tally-pdf"]')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        await downloadTallyResultPdf({
          kind: 'first',
          title: `${FIRST_PANELS[selectedPanel].label} 결과표`,
          statusLabel: STATUS[panel.status] || panel.status,
          generatedAt: new Date().toISOString(),
          summaryLine: `대상 작품 ${targetEntries.length}건 · 온라인 위원 ${panel.judges.length}명 · 수동(엑셀) ${(panel.manualJudges || []).length}명 · 총 평가 ${totalScores}건`,
          rows: ranked,
          note: '※ 예선 심사 환산식: 문제 인식(×4, 40점) + 기능 구현 수준(×3, 30점) + 완성도(×2, 20점) + 확산 가능성(×1, 10점) = 100점 만점',
        }, `예선심사결과_${FIRST_PANELS[selectedPanel].institution}`);
        toastOk('예선 심사 결과 PDF를 다운로드했습니다.');
      } catch (error) { toastErr(error.message); }
      finally { btn.disabled = false; }
    });
    root.querySelector('[data-testid="first-tally-xlsx"]')?.addEventListener('click', () => {
      const summaryRows = [
        ['순위', '접수번호', '소속기관', '작품명', '제출자', '전체평가수', '온라인수', '수동엑셀수', '문제인식(40)', '기능구현(30)', '완성도(20)', '확산가능성(10)', '환산평균(100)'],
        ...ranked.map((r) => [
          r.rank ?? '', r.entryId, r.institution, r.title, r.authorName,
          r.scoreCount, r.onlineCount, r.manualCount,
          r.criterionAverages?.[0] ?? '', r.criterionAverages?.[1] ?? '', r.criterionAverages?.[2] ?? '', r.criterionAverages?.[3] ?? '',
          r.average != null ? Number(r.average.toFixed(2)) : '',
        ]),
      ];
      const detailRows = [
        ['구분', '심사위원', '접수번호', '작품명', '문제인식', '기능구현', '완성도', '확산가능성', '합계(100)'],
        ...panel.scores.map((row) => [
          row.source === 'excel' ? '수동(엑셀)' : '온라인',
          judgeNameOf(row),
          row.entryId,
          entries.find((e) => e.id === row.entryId)?.title || row.entryId,
          row.scores[0], row.scores[1], row.scores[2], row.scores[3], totalOf(row.scores),
        ]),
      ];
      const blob = buildXlsx([
        { name: '예선_결과순위', rows: summaryRows },
        { name: '위원별_상세점수', rows: detailRows },
      ]);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadBlob(blob, `예선심사결과_${FIRST_PANELS[selectedPanel].institution}_${stamp}.xlsx`);
      toastOk('예선 심사 결과 엑셀을 다운로드했습니다.');
    });
  };

  try { await render(true); }
  catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err">${esc(error.message)}</p>`; }
}

/* ----------------------------------------------------- 본선 심사 현황 -- */

export async function festaFinalTallyView(mount) {
  const root = shell(mount, 'tally-final', '본선 심사 현황', '2차 본선 심사 진행 현황과 수동심사 엑셀을 반영하고 최종 심사 결과 PDF를 내려받습니다.');
  if (!isAdmin()) { root.innerHTML = '<p class="notice notice--err">관리자만 이용할 수 있습니다.</p>'; return; }
  let cachedAdmin = null;
  let cachedAwards = null;
  const uploadState = { fileName: '', mode: 'merge', valid: [], errors: [] };

  const render = async (reload = true) => {
    if (reload || !cachedAdmin) {
      [cachedAdmin, cachedAwards] = await Promise.all([
        api('/festa/jury/admin'),
        api('/festa/awards/preview').catch(() => null),
      ]);
    }
    if (!root.isConnected) return;
    const entries = Array.isArray(cachedAdmin.entries) ? cachedAdmin.entries : [];
    const panel = (cachedAdmin.panels || []).find((p) => p.key === 'final')
      || { key: 'final', label: '2차 본선 평가', status: 'draft', entryIds: [], participants: [], manualJudges: [], adminTests: [], scores: [], results: [] };
    const targetEntries = panel.entryIds.map((id) => entries.find((e) => e.id === id)).filter(Boolean);
    const recipients = cachedAwards?.publication?.recipients || cachedAwards?.recipients || [];
    const awardByTitleOrEntry = new Map();
    for (const rec of recipients) {
      awardByTitleOrEntry.set(`${rec.name}::${rec.projectTitle}`, rec.awardName);
    }

    const rankingSource = Array.isArray(cachedAwards?.ranking) && cachedAwards.ranking.length
      ? cachedAwards.ranking.map((row, idx) => ({
        rank: row.average !== null ? idx + 1 : null,
        entryId: row.entryId,
        institution: row.institution,
        title: row.projectTitle,
        authorName: row.name,
        scoreCount: row.ballotCount ?? 0,
        onlineCount: (panel.results.find((r) => r.entryId === row.entryId)?.onlineCount) ?? row.ballotCount ?? 0,
        manualCount: (panel.results.find((r) => r.entryId === row.entryId)?.manualCount) ?? 0,
        criterionAverages: row.criterionAverages,
        average: row.average,
        awardName: awardByTitleOrEntry.get(`${row.name}::${row.projectTitle}`) || '',
      }))
      : targetEntries.map((entry) => {
        const r = (panel.results || []).find((x) => x.entryId === entry.id) || {};
        return {
          rank: null,
          entryId: entry.id,
          institution: entry.institution || '',
          title: entry.title,
          authorName: entry.author?.name || '',
          scoreCount: r.scoreCount || 0,
          onlineCount: r.onlineCount || 0,
          manualCount: r.manualCount || 0,
          criterionAverages: r.criterionAverages || null,
          average: typeof r.average === 'number' && Number.isFinite(r.average) ? r.average : null,
          awardName: '',
        };
      }).sort((a, b) => (b.average ?? -1) - (a.average ?? -1)).map((row, idx) => ({
        ...row, rank: row.average !== null ? idx + 1 : null,
      }));

    const onlineParticipants = (panel.participants || []).filter((p) => !p.manual).length;
    const manualCount = (panel.manualJudges || []).length;
    const totalScores = (panel.scores || []).length;
    const statusLabel = cachedAwards?.published ? '수상 확정·공개 완료' : (STATUS[panel.status] || panel.status);

    const participantNameOf = (row) => {
      if (row.judgeName) return row.judgeName;
      return (panel.participants || []).find((p) => p.id === row.judgeId)?.name
        || (panel.manualJudges || []).find((j) => j.id === row.judgeId)?.name
        || '평가 참여자';
    };

    root.innerHTML = `<div class="fj-head">
        <div>
          <span class="badge ${cachedAwards?.published ? 'badge--gold' : panel.status === 'open' ? 'badge--open' : panel.status === 'closed' ? 'badge--closed' : 'badge--soft'}">${esc(statusLabel)}</span>
        </div>
        <div class="fj-actions">
          <a class="btn btn--outline btn--sm" href="#/festa/jury/final">본선 화면 테스트</a>
          <a class="btn btn--outline btn--sm" href="#/admin/festa/awards">수상작 확정·발표</a>
          <button type="button" class="btn btn--quiet btn--sm" data-tally-refresh>새로고침</button>
        </div>
      </div>
      ${adminTestNoticeHtml(panel)}
      <div class="stat-row">
        ${stat(`${targetEntries.length} / 6건`, '본선 대상 작품')}
        ${stat(`${onlineParticipants}명`, '온라인 참여자')}
        ${stat(`${manualCount}명`, '수동심사(엑셀) 참여자')}
        ${stat(`${totalScores}건`, '총 유효 평가 수')}
      </div>
      <section class="card fj-stack" data-testid="final-tally-ranking">
        <div class="fj-head">
          <div>
            <h2 class="page-title" style="font-size:2.2rem">최종 심사 집계 결과</h2>
            <p class="field__hint">행정안전부 상위 2명 + 한국서부발전 상위 1명 중 최우수상 1명·우수상 2명, 나머지 3명은 장려상으로 선정됩니다.</p>
          </div>
          <div class="fj-actions">
            <button type="button" class="btn btn--primary" data-testid="final-tally-pdf" ${rankingSource.length ? '' : 'disabled'}>📄 최종 심사 결과 PDF 다운로드</button>
            <button type="button" class="btn btn--outline" data-testid="final-tally-xlsx" ${rankingSource.length ? '' : 'disabled'}>📊 최종 집계 엑셀 다운로드</button>
          </div>
        </div>
        ${cachedAwards?.issues?.length ? `<div class="notice notice--warn"><div><strong>최종 확정 전 확인 사항</strong><ul style="margin-top:6px;padding-left:1.8rem;list-style:disc">${cachedAwards.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div></div>` : ''}
        ${rankingSource.length ? `<div class="fj-table-wrap"><table class="fj-table">
          <thead><tr><th>순위</th><th>기관</th><th>작품명 · 제출자</th><th>평가수</th>${RUBRIC.map((r) => `<th>${r.name} (${r.max})</th>`).join('')}<th>최종 평균 (100)</th><th>수상 구분</th></tr></thead>
          <tbody>${rankingSource.map((row) => `<tr>
            <td>${row.rank ? `<span class="badge ${row.rank <= 3 ? 'badge--gold' : 'badge--soft'}">${row.rank}위</span>` : '—'}</td>
            <td>${esc(row.institution)}</td>
            <td><strong>${esc(row.title)}</strong><br><span class="field__hint">${esc(row.authorName)}</span></td>
            <td>${row.scoreCount}건 <span class="field__hint">(${row.onlineCount}/${row.manualCount})</span></td>
            ${[0, 1, 2, 3].map((i) => `<td>${fmtAvg(row.criterionAverages?.[i])}</td>`).join('')}
            <td><strong>${row.average !== null ? `${row.average.toFixed(1)}점` : '—'}</strong></td>
            <td>${row.awardName ? `<span class="badge badge--gold">${esc(row.awardName)}</span>` : '<span class="field__hint">대기</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : emptyState({ title: '본선 대상 작품이 없습니다', body: '[심사위원·평가 대상 관리]의 2차 본선 평가 탭에서 본선 6작품을 먼저 선택해 주세요.' })}
        ${recipients.length ? `<div class="card card--flat fj-stack">
          <h4>${cachedAwards?.published ? '확정·공개된 수상 결과' : '예정 수상 결과 요약'}</h4>
          <div class="festa-awards-preview-list">${recipients.map((rec) => `<article><span class="badge badge--gold">${esc(rec.awardName)}</span><strong>${esc(rec.institution)} · ${esc(rec.name)}</strong><span>${esc(rec.projectTitle)}</span><span>${esc(rec.certificate)} · ${esc(rec.prizeText)}</span></article>`).join('')}</div>
        </div>` : ''}
      </section>
      ${manualExcelSectionHtml(panel, targetEntries, uploadState)}
      <section class="card fj-stack">
        <h3 style="font-size:2rem">평가 참여자별 상세 점수 내역</h3>
        ${panel.scores.length ? `<div class="fj-table-wrap"><table class="fj-table" data-testid="final-tally-scores">
          <thead><tr><th>구분</th><th>평가 참여자</th><th>작품</th>${RUBRIC.map((r) => `<th>${r.name} (${r.max})</th>`).join('')}<th>합계 (100)</th></tr></thead>
          <tbody>${panel.scores.map((row) => `<tr>
            <td>${row.source === 'excel' ? '<span class="badge badge--soft">수동(엑셀)</span>' : '<span class="badge badge--open">온라인</span>'}</td>
            <td>${esc(participantNameOf(row))}</td>
            <td>${esc(entries.find((e) => e.id === row.entryId)?.title || row.entryId)}</td>
            ${[0, 1, 2, 3].map((i) => `<td>${row.scores[i]}</td>`).join('')}
            <td><strong>${totalOf(row.scores) ?? '—'}점</strong></td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<p class="fj-note">아직 저장된 본선 평가 점수가 없습니다.</p>'}
      </section>`;

    root.querySelector('[data-tally-refresh]').addEventListener('click', () => render(true).catch((e) => toastErr(e.message)));
    bindManualExcelHandlers(root, panel, targetEntries, uploadState, render);

    root.querySelector('[data-testid="final-tally-pdf"]')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        await downloadTallyResultPdf({
          kind: 'final',
          title: '최종 심사 집계 결과표',
          statusLabel,
          generatedAt: new Date().toISOString(),
          summaryLine: `본선 작품 ${targetEntries.length}건 · 온라인 참여 ${onlineParticipants}명 · 수동(엑셀) ${manualCount}명 · 총 유효 평가 ${totalScores}건`,
          rows: rankingSource,
          recipients,
          note: '※ 선정 기준: 행정안전부 상위 2명·한국서부발전 상위 1명 중 평균 순 최우수상 1명·우수상 2명, 나머지 3명 장려상',
        }, '최종심사결과');
        toastOk('최종 심사 결과 PDF를 다운로드했습니다.');
      } catch (error) { toastErr(error.message); }
      finally { btn.disabled = false; }
    });

    root.querySelector('[data-testid="final-tally-xlsx"]')?.addEventListener('click', () => {
      const summaryRows = [
        ['순위', '접수번호', '소속기관', '작품명', '제출자', '전체평가수', '온라인수', '수동엑셀수', '문제인식(40)', '기능구현(30)', '완성도(20)', '확산가능성(10)', '최종평균(100)', '수상구분'],
        ...rankingSource.map((r) => [
          r.rank ?? '', r.entryId, r.institution, r.title, r.authorName,
          r.scoreCount, r.onlineCount, r.manualCount,
          r.criterionAverages?.[0] ?? '', r.criterionAverages?.[1] ?? '', r.criterionAverages?.[2] ?? '', r.criterionAverages?.[3] ?? '',
          r.average != null ? Number(r.average.toFixed(2)) : '', r.awardName || '',
        ]),
      ];
      const detailRows = [
        ['구분', '평가자', '접수번호', '작품명', '문제인식(40)', '기능구현(30)', '완성도(20)', '확산가능성(10)', '합계(100)'],
        ...panel.scores.map((row) => [
          row.source === 'excel' ? '수동(엑셀)' : '온라인',
          participantNameOf(row),
          row.entryId,
          entries.find((e) => e.id === row.entryId)?.title || row.entryId,
          row.scores[0], row.scores[1], row.scores[2], row.scores[3], totalOf(row.scores),
        ]),
      ];
      const blob = buildXlsx([
        { name: '최종_집계순위', rows: summaryRows },
        { name: '참여자별_상세점수', rows: detailRows },
      ]);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadBlob(blob, `최종심사집계_${stamp}.xlsx`);
      toastOk('최종 심사 집계 엑셀을 다운로드했습니다.');
    });
  };

  try { await render(true); }
  catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err">${esc(error.message)}</p>`; }
}
