/**
 * 관리자 — 수강 현황.
 *
 *   #/admin/attendance            대시보드
 *   #/admin/attendance/roster     전체 명단
 *   #/admin/attendance/sessions   회차별 기록 (?s=회차id)
 *   #/admin/attendance/students   학생별 상세 (?id=학생id)
 *
 * 규칙과 계산은 attendance.js, 파일 읽기·쓰기는 sheet.js 에 있습니다.
 * 이 파일은 화면과 상호작용만 맡습니다.
 */
import { store } from '../store/index.js';
import { esc, attr, uid, debounce, downloadBlob, fmtDate, $ } from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, confirmModal, stat, busy,
} from '../ui.js';
import { readSheet, buildXlsx } from '../sheet.js';
import {
  SESSIONS, sessionLabel, sessionShort, shortDate, mergeSessions, toRecord,
  findColumns, extractRoster, extractDisplayNames, columnValues,
  matchAll, labelFor, shortLabelFor, mergeRoster, pruneSessions,
  computeStats, detailRows, summaryRows, normalizeName, pct,
} from '../attendance.js';

/* ========================================================== 공통 틀 == */

const TABS = [
  { id: 'dashboard', label: '대시보드', href: '#/admin/attendance', sub: '전체 진행 상황을 한눈에 봅니다.' },
  { id: 'roster', label: '전체 명단', href: '#/admin/attendance/roster', sub: '수강생 명단을 한 번 올려두면 이후 회차는 자동으로 대조됩니다.' },
  { id: 'sessions', label: '회차별 기록', href: '#/admin/attendance/sessions', sub: '회차마다 출석자·제출자를 올리거나 직접 체크합니다.' },
  { id: 'students', label: '학생별 상세', href: '#/admin/attendance/students', sub: '학생 한 명의 전 회차 이력을 봅니다.' },
];

/** 페이지 뼈대를 그리고 내용이 들어갈 자리를 돌려줍니다. */
function shell(mount, tabId) {
  const tab = TABS.find((t) => t.id === tabId);
  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <p class="crumb"><a href="#/admin">관리자</a><span>/</span>수강 현황</p>
        <div class="page-head">
          <div>
            <h1 class="page-title">수강 현황</h1>
            <p class="page-sub">${esc(tab.sub)}</p>
          </div>
          <div class="row">
            <button class="btn btn--outline" data-xlsx>엑셀로 내보내기</button>
          </div>
        </div>

        <nav class="subnav" aria-label="수강 현황 메뉴">
          ${TABS.map((t) => `
            <a class="subnav__item${t.id === tabId ? ' is-active' : ''}" href="${attr(t.href)}"
               ${t.id === tabId ? 'aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')}
        </nav>

        <div id="attBody">${spinner()}</div>
      </div>
    </section>`;
  return mount.querySelector('#attBody');
}

/** 명단과 회차 기록을 함께 읽어 화면이 쓰는 모양으로 돌려줍니다. */
async function load() {
  const [roster, records] = await Promise.all([store.listStudents(), store.listAttendance()]);
  return { roster: Array.isArray(roster) ? roster : [], sessions: mergeSessions(records) };
}

/** 아직 아무것도 없을 때 모든 화면이 같은 말을 하도록. */
const needRoster = () => emptyState({
  title: '전체 명단을 먼저 올려주세요',
  body: '이름과 소속이 담긴 CSV 또는 엑셀 파일을 한 번만 올리면 됩니다.',
  action: '<a class="btn btn--primary" href="#/admin/attendance/roster">전체 명단 올리기</a>',
});

function bindExport(mount, data) {
  const btn = mount.querySelector('[data-xlsx]');
  if (!btn) return;
  btn.addEventListener('click', () => exportXlsx(data));
}

/** 학생별 상세 + 회차별 요약, 두 장짜리 엑셀. */
function exportXlsx({ roster, sessions }) {
  if (!roster.length) { toastErr('내보낼 명단이 없습니다.'); return; }
  const stats = computeStats(roster, sessions);
  try {
    const blob = buildXlsx([
      { name: '학생별 상세', rows: detailRows(roster, sessions, stats) },
      { name: '회차별 요약', rows: summaryRows(stats) },
    ]);
    downloadBlob(blob, `수강현황_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toastOk('엑셀 파일을 내려받았습니다.');
  } catch (e) {
    toastErr(`내보내기 실패 — ${e.message}`);
  }
}

/* ====================================================== 파일 올리기 == */

/** 드래그&드롭 + 클릭으로 파일 하나를 받는 상자. */
function dropBox({ label, hint, action = '파일 선택' }) {
  return `
    <div class="drop drop--slim" data-drop tabindex="0" role="button"
         aria-label="${attr(label)} — 파일을 선택하거나 끌어다 놓으세요">
      <div>
        <div class="drop__title">${esc(label)}</div>
        <div class="drop__hint">${esc(hint)}</div>
      </div>
      <span class="btn btn--outline btn--sm" aria-hidden="true">${esc(action)}</span>
      <input type="file" hidden data-input accept=".csv,.tsv,.txt,.xlsx,.xls" />
    </div>`;
}

function bindDrop(box, onFile) {
  const input = box.querySelector('[data-input]');
  box.addEventListener('click', () => input.click());
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) onFile(f);
  });
  ['dragenter', 'dragover'].forEach((t) => box.addEventListener(t, (e) => {
    e.preventDefault(); box.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((t) => box.addEventListener(t, (e) => {
    e.preventDefault(); box.classList.remove('is-over');
  }));
  box.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}

/**
 * 어느 열이 이름·소속인지 스스로 못 찾았을 때 사람에게 묻습니다.
 * @returns {Promise<{nameCol:number, deptCol:number, headerRow:number}|null>}
 */
function columnModal(rows, { needDept = true } = {}) {
  const head = rows.slice(0, 6);
  const width = head.reduce((n, r) => Math.max(n, (r || []).length), 0);
  const options = (selected) => Array.from({ length: width }, (_, c) => {
    const sample = head.map((r) => String((r || [])[c] ?? '').trim()).find(Boolean) || '';
    return `<option value="${c}"${c === selected ? ' selected' : ''}>${
      esc(`${c + 1}번째 열${sample ? ` — ${sample.slice(0, 18)}` : ''}`)}</option>`;
  }).join('');

  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-scrim" data-scrim>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="colTitle">
          <h2 id="colTitle">어느 열이 이름인가요?</h2>
          <p style="color:var(--text-black-soft);line-height:1.7">
            '이름' 같은 머리글을 찾지 못했습니다. 아래에서 직접 골라주세요.
          </p>
          <div class="tablewrap" style="margin:var(--space-3) 0">
            <table class="table table--compact" style="min-width:0">
              <tbody>
                ${head.map((r) => `<tr>${Array.from({ length: width }, (_, c) =>
    `<td>${esc(String((r || [])[c] ?? '').slice(0, 16))}</td>`).join('')}</tr>`).join('')}
              </tbody>
            </table>
          </div>
          <label class="field">
            <span class="field__label">머리글 줄</span>
            <select class="select" data-header>
              <option value="-1">머리글 없음 (첫 줄부터 자료)</option>
              ${head.map((r, i) => `<option value="${i}">${
    esc(`${i + 1}번째 줄 — ${(r || []).slice(0, 3).join(' / ').slice(0, 24)}`)}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span class="field__label">이름 열<span class="field__req">*</span></span>
            <select class="select" data-name>${options(0)}</select>
          </label>
          ${needDept ? `
            <label class="field">
              <span class="field__label">소속 열 (없으면 비워두세요)</span>
              <select class="select" data-dept>
                <option value="-1">없음</option>${options(-1)}
              </select>
            </label>` : ''}
          <div class="modal__actions">
            <button class="btn btn--quiet" data-cancel>취소</button>
            <button class="btn btn--primary" data-ok>이 열로 읽기</button>
          </div>
        </div>
      </div>`;

    const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.querySelector('[data-scrim]').addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-scrim')) close(null);
    });
    root.querySelector('[data-ok]').addEventListener('click', () => close({
      nameCol: Number(root.querySelector('[data-name]').value),
      deptCol: needDept ? Number(root.querySelector('[data-dept]').value) : -1,
      headerRow: Number(root.querySelector('[data-header]').value),
    }));
    root.querySelector('[data-name]').focus();
  });
}

/* ============================================== 업로드 확인 팝업 == */

/**
 * 자동으로 못 정한 이름들을 사람에게 확인받습니다.
 *
 * @param {{fieldLabel:string, session:object, result:object}} opts
 * @returns {Promise<{mode:'replace'|'add', ids:string[], newNames:string[]}|null>}
 */
function reviewModal({ fieldLabel, session, result }) {
  const { matched, ambiguous, unmatched, total } = result;

  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-scrim" data-scrim>
        <div class="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="revTitle">
          <h2 id="revTitle">${esc(sessionLabel(session))} ${esc(fieldLabel)} 반영</h2>
          <p style="color:var(--text-black-soft);line-height:1.7">
            파일에서 이름 ${total}건을 읽어 <strong>${matched.length}명</strong>을 명단과 맞췄습니다.
            ${ambiguous.length || unmatched.length
    ? '아래는 스스로 정하지 못한 이름입니다. 확인해 주세요.'
    : '확인만 하시면 바로 반영합니다.'}
          </p>

          ${ambiguous.length ? `
            <h3 class="att-h3">동명이인 ${ambiguous.length}건 — 해당하는 사람을 고르세요</h3>
            ${ambiguous.map((g, gi) => `
              <div class="att-group">
                <div class="att-group__head">
                  ${esc(g.name)}
                  <span class="badge badge--soft">파일에 ${g.raws.length}번</span>
                </div>
                <div class="att-group__raw">${esc(g.raws.slice(0, 4).join(' · '))}</div>
                ${g.options.map((opt) => `
                  <label class="check">
                    <input type="checkbox" data-amb="${gi}" value="${attr(opt.id)}" />
                    <span>${esc(opt.dept || '소속 미상')}</span>
                  </label>`).join('')}
              </div>`).join('')}` : ''}

          ${unmatched.length ? `
            <h3 class="att-h3">명단에 없는 이름 ${unmatched.length}건</h3>
            <p style="color:var(--text-black-soft);font-size:1.3rem;margin-bottom:var(--space-2)">
              오타이거나 명단에서 빠진 학생입니다. 체크하면 전체 명단에 새로 넣고 이번 회차에도 반영합니다.
            </p>
            <div class="row" style="margin-bottom:var(--space-2)">
              <button type="button" class="btn btn--quiet btn--sm" data-all-new>모두 선택</button>
              <button type="button" class="btn btn--quiet btn--sm" data-none-new>모두 해제</button>
            </div>
            ${unmatched.map((u, ui) => `
              <label class="check">
                <input type="checkbox" data-new="${ui}" value="${attr(u.guess)}" />
                <span>${esc(u.guess)}
                  <span class="att-group__raw">${esc(u.raws.slice(0, 3).join(' · '))}</span>
                </span>
              </label>`).join('')}` : ''}

          <h3 class="att-h3">반영 방법</h3>
          <label class="check">
            <input type="radio" name="attMode" value="replace" checked />
            <span>이 회차 ${esc(fieldLabel)} 기록을 <strong>파일 내용으로 교체</strong>합니다 (권장)</span>
          </label>
          <label class="check">
            <input type="radio" name="attMode" value="add" />
            <span>이미 있는 기록에 <strong>더합니다</strong> (파일을 나눠서 올릴 때)</span>
          </label>

          <div class="modal__actions">
            <button class="btn btn--quiet" data-cancel>취소</button>
            <button class="btn btn--primary" data-ok>반영</button>
          </div>
        </div>
      </div>`;

    const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    const toggleNew = (on) => root.querySelectorAll('[data-new]').forEach((el) => { el.checked = on; });
    root.querySelector('[data-all-new]')?.addEventListener('click', () => toggleNew(true));
    root.querySelector('[data-none-new]')?.addEventListener('click', () => toggleNew(false));

    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.querySelector('[data-scrim]').addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-scrim')) close(null);
    });
    root.querySelector('[data-ok]').addEventListener('click', () => {
      const ids = [...matched];
      root.querySelectorAll('[data-amb]:checked').forEach((el) => ids.push(el.value));
      const newNames = [...root.querySelectorAll('[data-new]:checked')].map((el) => el.value);
      close({
        mode: root.querySelector('input[name="attMode"]:checked').value,
        ids: [...new Set(ids)],
        newNames,
      });
    });
    root.querySelector('[data-ok]').focus();
  });
}

/* ======================================================== 대시보드 == */

export async function attendanceView(mount) {
  const body = shell(mount, 'dashboard');
  const data = await load();
  bindExport(mount, data);

  const { roster, sessions } = data;
  const stats = computeStats(roster, sessions);

  body.innerHTML = `
    <div class="stat-row" style="margin-bottom:var(--space-5)">
      ${stat(stats.total, '전체 수강생')}
      ${stat(pct(stats.avgAtt), '평균 출석률')}
      ${stat(pct(stats.avgSub), '평균 제출률')}
      ${stat(`${stats.recordedCount}/${SESSIONS.length}`, '기록된 회차')}
      ${stat(stats.atRisk.length, '주의가 필요한 학생')}
    </div>

    <div class="card" style="margin-bottom:var(--space-5)">
      <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">회차별 현황</h2>
      <div class="tablewrap">
        <table class="table">
          <thead><tr>
            <th>회차</th><th>일자</th><th>주제</th><th>출석</th><th>제출</th><th></th>
          </tr></thead>
          <tbody>
            ${stats.perSession.map((s) => `
              <tr>
                <td style="white-space:nowrap">
                  <strong>${esc(sessionLabel(s))}</strong>
                  ${s.recorded ? '' : '<br><span class="badge badge--soft">미기록</span>'}
                </td>
                <td style="white-space:nowrap">${esc(s.date ? fmtDate(`${s.date}T00:00:00+09:00`) : '미정')}</td>
                <td>${esc(s.title)}</td>
                <td>${s.recorded ? rateCell(s.attCount, stats.total, s.attRate) : '—'}</td>
                <td>${s.recorded ? rateCell(s.subCount, stats.total, s.subRate, 'bar--sub') : '—'}</td>
                <td style="white-space:nowrap">
                  <a class="btn btn--quiet btn--sm" href="#/admin/attendance/sessions?s=${attr(s.id)}">기록</a>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--space-5)">
      <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">주의가 필요한 학생</h2>
      ${stats.atRisk.length ? `
        <p style="color:var(--text-black-soft);font-size:1.4rem;margin-bottom:var(--space-3)">
          한 회차라도 <strong>결석과 미제출이 겹친</strong> 학생입니다. 이름을 누르면 이력이 열립니다.
        </p>
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>이름</th><th>소속</th><th>겹친 회차</th><th>결석</th><th>미제출</th></tr></thead>
            <tbody>
              ${stats.atRisk.map((p) => `
                <tr>
                  <td><a href="#/admin/attendance/students?id=${attr(p.entry.id)}">${esc(p.entry.name)}</a></td>
                  <td>${esc(p.entry.dept || '—')}</td>
                  <td>${p.riskSessions.map((id) => {
    const s = sessions.find((x) => x.id === id);
    return `<span class="badge badge--due">${esc(s ? sessionLabel(s) : id)}</span>`;
  }).join(' ')}</td>
                  <td class="num">${p.absentCount}회</td>
                  <td class="num">${p.missingCount}회</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`
    : `<p style="color:var(--text-black-soft)">${stats.recordedCount
      ? '결석과 미제출이 함께 있는 학생이 없습니다.'
      : '아직 기록된 회차가 없습니다.'}</p>`}
    </div>

    <div class="card">
      <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">전체 학생</h2>
      <div id="matrix">${roster.length ? '' : needRoster()}</div>
    </div>`;

  if (roster.length) body.querySelector('#matrix').innerHTML = matrixTable(roster, sessions, stats);
}

const rateCell = (n, total, rate, cls = '') => `
  <div style="min-width:110px">
    <div style="font-size:1.3rem">${n}<span style="color:var(--text-black-mute)">/${total}</span>
      · ${pct(rate)}</div>
    <div class="bar"><span class="bar__fill ${cls}" style="width:${Math.round(rate * 100)}%"></span></div>
  </div>`;

/** 학생 × 회차 표. 첫 열(이름)은 가로로 스크롤해도 붙어 있습니다. */
function matrixTable(roster, sessions, stats) {
  const byId = new Map(stats.perStudent.map((p) => [p.entry.id, p]));
  return `
    <div class="tablewrap">
      <table class="table table--matrix">
        <thead>
          <tr>
            <th rowspan="2" class="sticky-col">이름</th>
            <th rowspan="2">소속</th>
            ${sessions.map((s) => `
              <th colspan="2" class="att-col">${esc(sessionShort(s))}
                <div class="att-col__date">${esc(shortDate(s.date) || '미정')}</div></th>`).join('')}
            <th rowspan="2">출석</th>
            <th rowspan="2">제출</th>
          </tr>
          <tr>
            ${sessions.map(() => '<th class="att-col">출</th><th>제</th>').join('')}
          </tr>
        </thead>
        <tbody>
          ${roster.map((entry) => {
    const p = byId.get(entry.id);
    return `
            <tr>
              <td class="sticky-col"><a href="#/admin/attendance/students?id=${attr(entry.id)}">${
  esc(shortLabelFor(entry, roster))}</a></td>
              <td class="att-dept">${esc(entry.dept || '—')}</td>
              ${p.rows.map((r) => `<td class="att-col">${mark(r.recorded, r.attended)}</td>`
    + `<td>${mark(r.recorded, r.submitted)}</td>`).join('')}
              <td class="num">${p.attCount}/${p.recordedCount}</td>
              <td class="num">${p.subCount}/${p.recordedCount}</td>
            </tr>`;
  }).join('')}
        </tbody>
      </table>
    </div>
    <p class="att-legend">
      <span class="mark mark--ok">○</span> 완료
      <span class="mark mark--no">×</span> 미완료
      <span class="mark mark--none">–</span> 아직 기록하지 않은 회차
    </p>`;
}

const mark = (recorded, ok) => (recorded
  ? `<span class="mark ${ok ? 'mark--ok' : 'mark--no'}" title="${ok ? '완료' : '미완료'}">${ok ? '○' : '×'}</span>`
  : '<span class="mark mark--none" title="미기록">–</span>');

/* ====================================================== 전체 명단 == */

export async function attendanceRosterView(mount) {
  const body = shell(mount, 'roster');
  let data = await load();
  bindExport(mount, data);

  const draw = () => {
    const { roster, sessions } = data;
    const stats = computeStats(roster, sessions);
    const dupNames = [...new Set(roster.filter((e, i) =>
      roster.some((o, j) => i !== j && o.name === e.name)).map((e) => e.name))];

    body.innerHTML = `
      <div class="card" style="margin-bottom:var(--space-4)">
        <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-2)">명단 올리기</h2>
        <p style="color:var(--text-black-soft);font-size:1.4rem;margin-bottom:var(--space-3)">
          '이름'·'성명' 과 '부서'·'소속' 열을 스스로 찾습니다. 못 찾으면 어느 열인지 물어봅니다.
          다시 올려도 <strong>이름과 소속이 같은 사람은 그대로 이어집니다</strong> — 지금까지 쌓은 출결이 남습니다.
        </p>
        <div id="rosterDrop">${dropBox({
    label: '전체 수강생 명단', hint: 'CSV 또는 XLSX · 이름 열 필수, 소속 열 있으면 함께 읽습니다',
  })}</div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4)">
        <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">직접 추가</h2>
        <form class="row" id="addForm" style="align-items:flex-end">
          <label class="field" style="margin:0;flex:1 1 180px">
            <span class="field__label">이름</span>
            <input class="input" name="name" autocomplete="off" required />
          </label>
          <label class="field" style="margin:0;flex:1 1 220px">
            <span class="field__label">소속</span>
            <input class="input" name="dept" autocomplete="off" />
          </label>
          <button class="btn btn--outline" type="submit">추가</button>
        </form>
      </div>

      ${dupNames.length ? `
        <div class="notice notice--info" style="margin-bottom:var(--space-4)">
          <strong>동명이인 ${dupNames.length}건</strong> — ${esc(dupNames.join(', '))}.
          소속이 다르면 다른 사람으로 봅니다. 출석 파일에 소속이 함께 적혀 있으면 자동으로 갈라내고,
          아니면 올릴 때 누구인지 물어봅니다.
        </div>` : ''}

      <div class="card">
        <div class="page-head" style="margin-bottom:var(--space-3)">
          <h2 class="page-title" style="font-size:2rem">등록된 명단 (${roster.length}명)</h2>
          <div class="row">
            <input class="input" id="rq" type="search" placeholder="이름 · 소속 검색" style="width:200px" />
            ${roster.length ? '<button class="btn btn--danger btn--sm" data-clear>명단 비우기</button>' : ''}
          </div>
        </div>
        <div id="rosterRows"></div>
      </div>`;

    bindDrop(body.querySelector('[data-drop]'), (file) => onRosterFile(file));

    const rowsEl = body.querySelector('#rosterRows');
    const qEl = body.querySelector('#rq');

    const drawRows = () => {
      const q = qEl.value.trim().toLowerCase();
      const shown = roster.filter((e) => !q
        || String(e.name).toLowerCase().includes(q) || String(e.dept || '').toLowerCase().includes(q));
      if (!roster.length) { rowsEl.innerHTML = needRoster(); return; }
      if (!shown.length) {
        rowsEl.innerHTML = emptyState({ title: '해당하는 학생이 없습니다', body: '검색어를 바꿔 보세요.' });
        return;
      }
      const byId = new Map(stats.perStudent.map((p) => [p.entry.id, p]));
      rowsEl.innerHTML = `
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>#</th><th>이름</th><th>소속</th><th>출석</th><th>제출</th><th></th></tr></thead>
            <tbody>
              ${shown.map((e) => {
    const p = byId.get(e.id);
    return `
                <tr>
                  <td class="num">${roster.indexOf(e) + 1}</td>
                  <td><a href="#/admin/attendance/students?id=${attr(e.id)}">${esc(e.name)}</a></td>
                  <td>${esc(e.dept || '—')}</td>
                  <td class="num">${p.attCount}/${p.recordedCount}</td>
                  <td class="num">${p.subCount}/${p.recordedCount}</td>
                  <td style="white-space:nowrap">
                    <button class="btn btn--quiet btn--sm" data-edit="${attr(e.id)}">수정</button>
                    <button class="btn btn--quiet btn--sm" data-del="${attr(e.id)}">삭제</button>
                  </td>
                </tr>`;
  }).join('')}
            </tbody>
          </table>
        </div>`;

      rowsEl.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', () => removeStudent(btn.dataset.del));
      });
      rowsEl.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => editStudent(btn.dataset.edit));
      });
    };

    qEl.addEventListener('input', debounce(drawRows, 150));
    drawRows();

    body.querySelector('#addForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const name = normalizeName(form.name.value);
      const dept = form.dept.value.trim();
      if (!name) { toastErr('이름을 입력하세요.'); return; }
      if (roster.some((x) => x.name === name && (x.dept || '') === dept)) {
        toastErr('이름과 소속이 같은 학생이 이미 있습니다.');
        return;
      }
      await persistRoster([...roster, {
        id: uid('st_'), name, dept, createdAt: new Date().toISOString(),
      }]);
      toastOk(`${name} 학생을 추가했습니다.`);
    });

    body.querySelector('[data-clear]')?.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: '명단을 비울까요?',
        body: '전체 명단과 회차별 출결 기록이 함께 사라집니다. 되돌릴 수 없습니다.',
        confirmLabel: '비우기', danger: true, requireText: '명단 삭제',
      });
      if (!ok) return;
      await store.saveStudents([]);
      await store.saveAttendance(sessions.map((s) =>
        toRecord({ ...s, attendance: [], submission: [], recorded: false })));
      data = await load();
      bindExport(mount, data);
      toastOk('명단과 기록을 모두 비웠습니다.');
      draw();
    });
  };

  /** 명단을 저장하고 화면을 다시 그립니다. 빠진 학생은 회차 기록에서도 지웁니다. */
  const persistRoster = async (nextRoster) => {
    const alive = nextRoster.map((e) => e.id);
    const cleaned = pruneSessions(data.sessions, alive);
    await store.saveStudents(nextRoster);
    const touched = cleaned.filter((s, i) =>
      s.attendance.length !== data.sessions[i].attendance.length
      || s.submission.length !== data.sessions[i].submission.length);
    if (touched.length) await store.saveAttendance(touched.map(toRecord));
    data = await load();
    bindExport(mount, data);
    draw();
  };

  const removeStudent = async (id) => {
    const entry = data.roster.find((e) => e.id === id);
    if (!entry) return;
    const marks = data.sessions.reduce((n, s) =>
      n + (s.attendance.includes(id) ? 1 : 0) + (s.submission.includes(id) ? 1 : 0), 0);
    const ok = await confirmModal({
      title: `${entry.name} 학생을 명단에서 지울까요?`,
      body: marks
        ? `이 학생의 출결·제출 기록 ${marks}건도 함께 사라집니다.`
        : '아직 기록된 출결이 없습니다.',
      confirmLabel: '삭제', danger: true,
    });
    if (!ok) return;
    await persistRoster(data.roster.filter((e) => e.id !== id));
    toastOk(`${entry.name} 학생을 지웠습니다.`);
  };

  const editStudent = async (id) => {
    const entry = data.roster.find((e) => e.id === id);
    if (!entry) return;
    const next = await editStudentModal(entry);
    if (!next) return;
    await persistRoster(data.roster.map((e) => (e.id === id
      ? { ...e, name: next.name, dept: next.dept } : e)));
    toastOk('학생 정보를 고쳤습니다.');
  };

  /** 파일 → 표 → 명단. 열을 못 찾으면 물어보고, 반영 전에 요약을 보여줍니다. */
  const onRosterFile = async (file) => {
    let rows;
    try {
      rows = await readSheet(file);
    } catch (e) { toastErr(e.message); return; }
    if (!rows.length) { toastErr('빈 파일입니다.'); return; }

    let cols = findColumns(rows);
    if (cols.nameCol < 0) {
      cols = await columnModal(rows, { needDept: true });
      if (!cols) return;
    }
    const incoming = extractRoster(rows, cols);
    if (!incoming.length) { toastErr('이름을 한 건도 읽지 못했습니다. 파일을 확인해 주세요.'); return; }

    const merged = mergeRoster(data.roster, incoming, () => uid('st_'));
    const lost = merged.removed.filter((e) => data.sessions.some((s) =>
      s.attendance.includes(e.id) || s.submission.includes(e.id)));

    const ok = await confirmModal({
      title: `${incoming.length}명을 읽었습니다`,
      body: [
        `새로 추가: ${merged.added.length}명`,
        `기존 유지: ${merged.kept.length}명 (지금까지의 출결이 그대로 남습니다)`,
        merged.removed.length
          ? `이번 파일에 없어 명단에서 빠짐: ${merged.removed.length}명`
            + (lost.length ? ` — 그 중 ${lost.length}명은 출결 기록이 있어 함께 지워집니다` : '')
          : null,
      ].filter(Boolean).join('\n'),
      confirmLabel: '이 명단으로 저장',
      danger: lost.length > 0,
    });
    if (!ok) return;

    await persistRoster(merged.roster);
    toastOk(`명단 ${merged.roster.length}명을 저장했습니다.`);
  };

  draw();
}

/** 이름·소속을 고치는 작은 창. */
function editStudentModal(entry) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-scrim" data-scrim>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="edTitle">
          <h2 id="edTitle">학생 정보 수정</h2>
          <label class="field">
            <span class="field__label">이름</span>
            <input class="input" data-name value="${attr(entry.name)}" />
          </label>
          <label class="field">
            <span class="field__label">소속</span>
            <input class="input" data-dept value="${attr(entry.dept || '')}" />
          </label>
          <div class="modal__actions">
            <button class="btn btn--quiet" data-cancel>취소</button>
            <button class="btn btn--primary" data-ok>저장</button>
          </div>
        </div>
      </div>`;
    const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.querySelector('[data-scrim]').addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-scrim')) close(null);
    });
    root.querySelector('[data-ok]').addEventListener('click', () => {
      const name = normalizeName(root.querySelector('[data-name]').value);
      if (!name) { toastErr('이름을 입력하세요.'); return; }
      close({ name, dept: root.querySelector('[data-dept]').value.trim() });
    });
    root.querySelector('[data-name]').focus();
  });
}

/* ==================================================== 회차별 기록 == */

export async function attendanceSessionsView(mount, params, query) {
  const body = shell(mount, 'sessions');
  let data = await load();
  bindExport(mount, data);

  /**
   * 지금 보고 있는 회차. 주소에 없으면 아직 기록하지 않은 첫 회차로 시작하되,
   * 그 뒤로는 **바뀌지 않습니다** — 한 번 기록하고 나면 "아직 안 한 첫 회차"가
   * 달라져서, 이어서 올린 제출자 파일이 옆 회차로 들어가 버립니다.
   */
  let activeId = query?.get('s')
    || (data.sessions.find((s) => !s.recorded) || data.sessions[0]).id;
  const current = () => data.sessions.find((s) => s.id === activeId) || data.sessions[0];

  // 고른 회차를 주소에도 남겨 새로고침해도 같은 회차가 열리게 합니다.
  // replaceState 는 hashchange 를 일으키지 않아 화면을 다시 그리지 않습니다.
  if (!query?.get('s')) {
    try {
      history.replaceState(null, '', `#/admin/attendance/sessions?s=${encodeURIComponent(activeId)}`);
    } catch { /* file:// 등에서 막힐 수 있습니다 */ }
  }

  const draw = () => {
    const session = current();
    const { roster } = data;

    body.innerHTML = `
      <div class="chips" style="margin-bottom:var(--space-4)">
        ${data.sessions.map((s) => `
          <a class="chip${s.id === session.id ? ' is-active' : ''}"
             href="#/admin/attendance/sessions?s=${attr(s.id)}">
            ${esc(sessionLabel(s))}${s.recorded
    ? '<span aria-hidden="true">✓</span><span class="sr-only">기록됨</span>' : ''}
          </a>`).join('')}
      </div>

      <div class="card" style="margin-bottom:var(--space-4)">
        <div class="page-head" style="margin-bottom:var(--space-2)">
          <div>
            <p class="page-sub" style="margin:0">
              ${esc(sessionLabel(session))} ·
              ${esc(session.date ? fmtDate(`${session.date}T00:00:00+09:00`) : '일자 미정')}
            </p>
            <h2 class="page-title" style="font-size:2.2rem">${esc(session.title)}</h2>
          </div>
          <button class="btn btn--quiet btn--sm" data-edit-session>회차 정보 수정</button>
        </div>
        ${session.desc ? `<p style="color:var(--text-black-soft);line-height:1.7">${esc(session.desc)}</p>` : ''}
        <div class="row" style="margin-top:var(--space-3)">
          <span class="badge ${session.recorded ? 'badge--open' : 'badge--soft'}">
            ${session.recorded ? '기록됨' : '미기록'}</span>
          <span style="color:var(--text-black-soft);font-size:1.4rem">
            출석 ${session.attendance.length}명 · 제출 ${session.submission.length}명
            ${session.updatedAt ? ` · 마지막 저장 ${esc(fmtDate(session.updatedAt, true))}` : ''}
          </span>
        </div>
      </div>

      ${roster.length ? `
        <div class="grid" style="margin-bottom:var(--space-4)">
          <div id="attDrop">${dropBox({
    label: '출석자 명단 올리기',
    hint: 'Zoom 접속기록 그대로 올려도 됩니다 — "부서명_이름"에서 이름만 뽑아냅니다',
  })}</div>
          <div id="subDrop">${dropBox({
    label: '과제 제출자 명단 올리기',
    hint: '이름이 있는 CSV·XLSX 파일',
  })}</div>
        </div>

        <div class="card">
          <div class="page-head" style="margin-bottom:var(--space-3)">
            <h2 class="page-title" style="font-size:2rem">직접 체크</h2>
            <div class="row">
              <select class="select" id="filter" style="width:auto">
                <option value="all">전체 보기</option>
                <option value="absent">결석자만</option>
                <option value="missing">미제출자만</option>
                <option value="either">결석 또는 미제출</option>
              </select>
              <input class="input" id="sq" type="search" placeholder="이름 검색" style="width:160px" />
            </div>
          </div>
          <div class="row" style="margin-bottom:var(--space-3)">
            <button class="btn btn--quiet btn--sm" data-bulk="att-all">전체 출석</button>
            <button class="btn btn--quiet btn--sm" data-bulk="att-none">출석 해제</button>
            <button class="btn btn--quiet btn--sm" data-bulk="sub-all">전체 제출</button>
            <button class="btn btn--quiet btn--sm" data-bulk="sub-none">제출 해제</button>
            <span class="grow"></span>
            ${session.recorded ? '<button class="btn btn--danger btn--sm" data-reset>이 회차 초기화</button>' : ''}
          </div>
          <div id="checkRows"></div>
          <div class="row" style="margin-top:var(--space-3)">
            <button class="btn btn--primary" data-save aria-disabled="true">저장</button>
            <span id="dirty" style="color:var(--text-black-soft);font-size:1.3rem"></span>
          </div>
        </div>` : needRoster()}`;

    body.querySelector('[data-edit-session]').addEventListener('click', () => editSession(session));
    if (!roster.length) return;

    bindDrop(body.querySelector('#attDrop [data-drop]'), (f) => onSessionFile(session, 'attendance', f));
    bindDrop(body.querySelector('#subDrop [data-drop]'), (f) => onSessionFile(session, 'submission', f));

    /* --- 직접 체크 --- */
    const draftAtt = new Set(session.attendance);
    const draftSub = new Set(session.submission);
    const rowsEl = body.querySelector('#checkRows');
    const saveBtn = body.querySelector('[data-save]');
    const dirtyEl = body.querySelector('#dirty');
    const filterEl = body.querySelector('#filter');
    const qEl = body.querySelector('#sq');

    const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
    const isDirty = () => !same(draftAtt, new Set(session.attendance))
      || !same(draftSub, new Set(session.submission));

    const refreshSave = () => {
      const dirty = isDirty();
      saveBtn.setAttribute('aria-disabled', dirty ? 'false' : 'true');
      dirtyEl.textContent = dirty
        ? `출석 ${draftAtt.size}명 · 제출 ${draftSub.size}명 — 저장하지 않은 변경이 있습니다.`
        : '';
    };

    const drawRows = () => {
      const q = qEl.value.trim();
      const shown = roster.filter((e) => {
        if (q && !e.name.includes(q) && !String(e.dept || '').includes(q)) return false;
        if (filterEl.value === 'absent') return !draftAtt.has(e.id);
        if (filterEl.value === 'missing') return !draftSub.has(e.id);
        if (filterEl.value === 'either') return !draftAtt.has(e.id) || !draftSub.has(e.id);
        return true;
      });
      if (!shown.length) {
        rowsEl.innerHTML = emptyState({ title: '해당하는 학생이 없습니다', body: '검색어나 필터를 바꿔 보세요.' });
        return;
      }
      rowsEl.innerHTML = `
        <div class="tablewrap">
          <table class="table table--compact">
            <thead><tr><th>이름</th><th>소속</th><th style="text-align:center">출석</th>
                       <th style="text-align:center">제출</th></tr></thead>
            <tbody>
              ${shown.map((e) => `
                <tr>
                  <td>${esc(e.name)}</td>
                  <td class="att-dept">${esc(e.dept || '—')}</td>
                  <td style="text-align:center">
                    <input type="checkbox" class="tick" data-att="${attr(e.id)}"
                      aria-label="${attr(`${e.name} 출석`)}" ${draftAtt.has(e.id) ? 'checked' : ''} />
                  </td>
                  <td style="text-align:center">
                    <input type="checkbox" class="tick" data-sub="${attr(e.id)}"
                      aria-label="${attr(`${e.name} 과제 제출`)}" ${draftSub.has(e.id) ? 'checked' : ''} />
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

      rowsEl.querySelectorAll('[data-att]').forEach((el) => el.addEventListener('change', () => {
        if (el.checked) draftAtt.add(el.dataset.att); else draftAtt.delete(el.dataset.att);
        refreshSave();
      }));
      rowsEl.querySelectorAll('[data-sub]').forEach((el) => el.addEventListener('change', () => {
        if (el.checked) draftSub.add(el.dataset.sub); else draftSub.delete(el.dataset.sub);
        refreshSave();
      }));
    };

    qEl.addEventListener('input', debounce(drawRows, 150));
    filterEl.addEventListener('change', drawRows);

    body.querySelectorAll('[data-bulk]').forEach((btn) => btn.addEventListener('click', () => {
      const all = roster.map((e) => e.id);
      const kind = btn.dataset.bulk;
      if (kind === 'att-all') all.forEach((id) => draftAtt.add(id));
      if (kind === 'att-none') draftAtt.clear();
      if (kind === 'sub-all') all.forEach((id) => draftSub.add(id));
      if (kind === 'sub-none') draftSub.clear();
      drawRows();
      refreshSave();
    }));

    saveBtn.addEventListener('click', async () => {
      if (saveBtn.getAttribute('aria-disabled') === 'true') return;
      busy(saveBtn, true, '저장 중…');
      try {
        await saveSession({
          ...session,
          attendance: [...draftAtt],
          submission: [...draftSub],
          recorded: true,
        });
        toastOk(`${sessionLabel(session)} 기록을 저장했습니다.`);
      } catch (e) {
        toastErr(`저장 실패 — ${e.message}`);
      } finally {
        busy(saveBtn, false);
      }
    });

    body.querySelector('[data-reset]')?.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: `${sessionLabel(session)} 기록을 지울까요?`,
        body: '이 회차의 출석·제출 체크가 모두 사라지고 다시 "미기록"이 됩니다.',
        confirmLabel: '초기화', danger: true,
      });
      if (!ok) return;
      await saveSession({ ...session, attendance: [], submission: [], recorded: false });
      toastOk('회차 기록을 초기화했습니다.');
    });

    drawRows();
    refreshSave();
  };

  const saveSession = async (session) => {
    await store.saveAttendance([toRecord({ ...session, updatedAt: new Date().toISOString() })]);
    data = await load();
    bindExport(mount, data);
    draw();
  };

  const editSession = async (session) => {
    const next = await editSessionModal(session);
    if (!next) return;
    await saveSession({ ...session, title: next.title, date: next.date });
    toastOk('회차 정보를 고쳤습니다.');
  };

  /** 출석·제출 파일 한 장을 읽어 명단과 맞춘 뒤 확인 팝업을 띄웁니다. */
  const onSessionFile = async (session, field, file) => {
    const fieldLabel = field === 'attendance' ? '출석' : '과제 제출';
    let rows;
    try {
      rows = await readSheet(file);
    } catch (e) { toastErr(e.message); return; }
    if (!rows.length) { toastErr('빈 파일입니다.'); return; }

    let names = extractDisplayNames(rows);
    if (!names.length) {
      const cols = await columnModal(rows, { needDept: false });
      if (!cols) return;
      names = columnValues(rows, cols.nameCol, cols.headerRow);
    }
    if (!names.length) { toastErr('이름을 한 건도 읽지 못했습니다.'); return; }

    const result = matchAll(names, data.roster);
    const choice = await reviewModal({ fieldLabel, session, result });
    if (!choice) return;

    // 새로 넣기로 한 이름을 먼저 명단에 올리고, 그 id 까지 함께 반영합니다.
    let roster = data.roster;
    const added = choice.newNames.map((name) => ({
      id: uid('st_'), name, dept: '', createdAt: new Date().toISOString(),
    }));
    if (added.length) {
      roster = [...roster, ...added];
      await store.saveStudents(roster);
    }

    const ids = new Set([...choice.ids, ...added.map((e) => e.id)]);
    const before = new Set(session[field]);
    const next = choice.mode === 'add' ? new Set([...before, ...ids]) : ids;

    await saveSession({ ...session, [field]: [...next], recorded: true });
    toastOk(`${sessionLabel(session)} ${fieldLabel} ${next.size}명을 반영했습니다.`
      + (added.length ? ` (명단에 ${added.length}명 추가)` : ''));
  };

  draw();
}

/** 회차 제목·일자를 고치는 작은 창 — 오프라인 회차는 일자가 비어 있습니다. */
function editSessionModal(session) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-scrim" data-scrim>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="esTitle">
          <h2 id="esTitle">${esc(sessionLabel(session))} 정보</h2>
          <label class="field">
            <span class="field__label">주제</span>
            <input class="input" data-title value="${attr(session.title)}" />
          </label>
          <label class="field">
            <span class="field__label">일자</span>
            <input class="input" type="date" data-date value="${attr(session.date || '')}" />
            <span class="field__hint">비워두면 '미정'으로 표시됩니다.</span>
          </label>
          <div class="modal__actions">
            <button class="btn btn--quiet" data-cancel>취소</button>
            <button class="btn btn--primary" data-ok>저장</button>
          </div>
        </div>
      </div>`;
    const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    root.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    root.querySelector('[data-scrim]').addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-scrim')) close(null);
    });
    root.querySelector('[data-ok]').addEventListener('click', () => close({
      title: root.querySelector('[data-title]').value.trim() || session.title,
      date: root.querySelector('[data-date]').value.trim(),
    }));
    root.querySelector('[data-title]').focus();
  });
}

/* ==================================================== 학생별 상세 == */

export async function attendanceStudentsView(mount, params, query) {
  const body = shell(mount, 'students');
  const data = await load();
  bindExport(mount, data);

  const { roster, sessions } = data;
  if (!roster.length) { body.innerHTML = needRoster(); return; }

  const stats = computeStats(roster, sessions);
  let selectedId = query?.get('id') || roster[0].id;

  body.innerHTML = `
    <div class="att-split">
      <div>
        <input class="input" id="pq" type="search" placeholder="이름 · 소속 검색"
               style="margin-bottom:var(--space-2)" />
        <div id="people" class="att-people"></div>
      </div>
      <div id="detail"></div>
    </div>`;

  const peopleEl = body.querySelector('#people');
  const detailEl = body.querySelector('#detail');
  const qEl = body.querySelector('#pq');

  const drawPeople = () => {
    const q = qEl.value.trim();
    const shown = roster.filter((e) => !q || e.name.includes(q) || String(e.dept || '').includes(q));
    if (!shown.length) {
      peopleEl.innerHTML = '<p style="color:var(--text-black-soft);padding:var(--space-2)">찾는 학생이 없습니다.</p>';
      return;
    }
    peopleEl.innerHTML = shown.map((e) => `
      <button class="att-person${e.id === selectedId ? ' is-active' : ''}" data-pick="${attr(e.id)}">
        <span>${esc(e.name)}</span>
        <span class="att-person__dept">${esc(e.dept || '소속 미상')}</span>
      </button>`).join('');
    peopleEl.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
      selectedId = btn.dataset.pick;
      // 주소에 남겨 새로고침해도 같은 학생이 열리게 합니다. replaceState 는
      // hashchange 를 일으키지 않아 화면을 통째로 다시 그리지 않습니다.
      try {
        history.replaceState(null, '',
          `#/admin/attendance/students?id=${encodeURIComponent(selectedId)}`);
      } catch { /* file:// 등에서 막힐 수 있습니다 */ }
      drawPeople();
      drawDetail();
    }));
  };

  const drawDetail = () => {
    const entry = roster.find((e) => e.id === selectedId) || roster[0];
    selectedId = entry.id;
    const p = stats.perStudent.find((x) => x.entry.id === entry.id);

    detailEl.innerHTML = `
      <div class="card">
        <div class="page-head" style="margin-bottom:var(--space-3)">
          <div>
            <h2 class="page-title" style="font-size:2.2rem">${esc(labelFor(entry, roster))}</h2>
            <p class="page-sub">${esc(entry.dept || '소속 미상')}</p>
          </div>
        </div>
        <div class="stat-row" style="margin-bottom:var(--space-4)">
          ${stat(`${p.attCount}/${p.recordedCount}`, '출석')}
          ${stat(`${p.subCount}/${p.recordedCount}`, '제출')}
          ${stat(pct(p.attRate), '출석률')}
          ${stat(pct(p.subRate), '제출률')}
        </div>
        ${p.riskSessions.length ? `
          <div class="notice notice--warn" style="margin-bottom:var(--space-3)">
            <strong>주의</strong> — ${p.riskSessions.map((id) => {
    const s = sessions.find((x) => x.id === id);
    return esc(s ? sessionLabel(s) : id);
  }).join(', ')}에 결석과 미제출이 겹쳤습니다.
          </div>` : ''}
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>회차</th><th>일자</th><th>주제</th><th>출석</th><th>과제</th></tr></thead>
            <tbody>
              ${p.rows.map((r) => {
    const s = sessions.find((x) => x.id === r.id);
    return `
                <tr>
                  <td style="white-space:nowrap"><strong>${esc(sessionLabel(s))}</strong></td>
                  <td style="white-space:nowrap">${esc(s.date ? fmtDate(`${s.date}T00:00:00+09:00`) : '미정')}</td>
                  <td>${esc(s.title)}</td>
                  <td>${r.recorded
    ? `<span class="badge ${r.attended ? 'badge--open' : 'badge--due'}">${r.attended ? '출석' : '결석'}</span>`
    : '<span class="badge badge--soft">미기록</span>'}</td>
                  <td>${r.recorded
    ? `<span class="badge ${r.submitted ? 'badge--open' : 'badge--due'}">${r.submitted ? '제출' : '미제출'}</span>`
    : '<span class="badge badge--soft">미기록</span>'}</td>
                </tr>`;
  }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  };

  qEl.addEventListener('input', debounce(drawPeople, 150));
  drawPeople();
  drawDetail();
}
