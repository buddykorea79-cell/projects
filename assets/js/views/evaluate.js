/**
 * 제출물 평가 — 한 화면에서 보고, 투표하고, 결과를 봅니다.
 *
 * 관리자가 프로젝트의 제출물을 한 화면에 펼쳐 놓고 훑어보며 마음에 드는 것을
 * 고릅니다. 원하면 순위(1~5위)까지 매길 수 있고, 순위를 하나라도 매긴 표가
 * 있으면 결과 화면이 순위표까지 보여줍니다.
 *
 * 무엇을 보여줄지는 제출물이 무엇을 냈는지에 따라 다릅니다.
 *   ① 이미지·동영상 첨부가 있으면 → 그대로 화면에 띄웁니다(눌러서 크게 보기).
 *   ② PDF 만 있으면            → PDF 를 그 자리에서 미리 봅니다.
 *   ③ 둘 다 없고 본문에 주소가 있으면 → 링크 + 그 사이트 미리보기 화면.
 *   ④ 아무것도 없으면          → 첨부 목록만.
 *
 * 투표용지는 관리자 한 사람당 프로젝트마다 한 장이고, 다시 내면 덮어씁니다.
 * 집계 규칙은 화면에 그대로 적어 둡니다 — 왜 이 순위인지 물으면 답할 수 있어야
 * 하기 때문입니다.
 */
import { store } from '../store/index.js';
import {
  esc, attr, fmtDate, fmtBytes, kindOf, downloadLink, firstUrl, csvCell, downloadBlob,
} from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, confirmModal, busy, lightbox,
} from '../ui.js';
import { currentUser } from '../auth.js';
import { go } from '../router.js';

/** 매길 수 있는 순위의 범위. shared/r2api.js 의 MAX_RANK 와 같은 값이어야 합니다. */
export const MAX_RANK = 5;

/** 순위 점수 — 1위 5점 … 5위 1점. 순위를 안 매긴 표는 0점(득표수로만 셉니다). */
export const pointsFor = (rank) => (
  Number.isInteger(rank) && rank >= 1 && rank <= MAX_RANK ? MAX_RANK + 1 - rank : 0
);

/**
 * 표를 모아 제출물별 성적표를 만듭니다.
 *
 * 정렬은 순위를 매긴 표가 하나라도 있으면 `순위점수 → 득표수 → 먼저 낸 순`,
 * 아무도 순위를 안 매겼으면 `득표수 → 먼저 낸 순` 입니다. 성적이 같으면 같은
 * 등수를 주고, 한 표도 못 받은 제출물에는 등수를 매기지 않습니다.
 */
export function tally(subs, ballots) {
  const rows = subs.map((sub) => ({ sub, votes: 0, points: 0, ranks: [], voters: [] }));
  const byId = new Map(rows.map((r) => [r.sub.id, r]));

  for (const ballot of ballots) {
    for (const pick of ballot.picks || []) {
      const row = byId.get(pick.submissionId);
      if (!row) continue;                      // 지워진 제출물에 남아 있던 표
      row.votes += 1;
      row.points += pointsFor(pick.rank);
      if (pick.rank) row.ranks.push(pick.rank);
      row.voters.push({ name: ballot.voter?.name || ballot.voter?.email || '?', rank: pick.rank });
    }
  }

  const ranked = rows.some((r) => r.ranks.length > 0);
  rows.sort((a, b) => (ranked ? b.points - a.points : 0)
    || b.votes - a.votes
    || String(a.sub.createdAt || '').localeCompare(String(b.sub.createdAt || '')));

  let place = 0;
  let prevKey = null;
  rows.forEach((row, i) => {
    const key = ranked ? `${row.points}/${row.votes}` : `${row.votes}`;
    if (key !== prevKey) { place = i + 1; prevKey = key; }
    row.place = row.votes ? place : null;
  });

  return { rows, ranked };
}

/* --------------------------------------------------------------- 화면 -- */

export async function evaluateView(mount, { projectId }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const project = await store.getProject(projectId);
  if (!project) { toastErr('프로젝트를 찾을 수 없습니다.'); go('/admin'); return; }

  const me = currentUser();
  const subs = (await store.listSubmissions({ projectId }))
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  let ballots = await store.listEvaluations({ projectId });
  const myBallot = () => ballots.find((b) => sameEmail(b.voter?.email, me.email)) || null;

  /** 내가 고른 제출물. key = 제출물 ID, value = 순위(없으면 null). */
  let picks = new Map((myBallot()?.picks || []).map((p) => [p.submissionId, p.rank ?? null]));

  // 이미 투표했다면 결과부터 보여줍니다 — 다시 열었을 때 궁금한 건 결과입니다.
  let tab = myBallot() ? 'result' : 'ballot';

  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <p class="crumb">
          <a href="#/admin">관리자</a><span>/</span>
          <a href="#/p/${attr(project.id)}">${esc(project.title)}</a><span>/</span>평가
        </p>
        <div class="page-head">
          <div>
            <h1 class="page-title">제출물 평가</h1>
            <p class="page-sub">${esc(project.title)} · 제출물 ${subs.length}건</p>
          </div>
          <div class="row">
            <a class="btn btn--outline" href="#/admin/submissions/${attr(project.id)}">제출물 관리</a>
            <a class="btn btn--quiet" href="#/admin/roster/${attr(project.id)}">제출 현황</a>
          </div>
        </div>

        ${subs.length ? `
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" aria-controls="evalBody" data-tab="ballot">평가하기</button>
          <button class="tab" role="tab" aria-controls="evalBody" data-tab="result">결과</button>
        </div>` : ''}

        <div id="evalBody" role="tabpanel" tabindex="-1"></div>
      </div>
    </section>`;

  const body = mount.querySelector('#evalBody');

  if (!subs.length) {
    body.innerHTML = emptyState({
      title: '평가할 제출물이 없습니다',
      body: '교육생이 과제를 제출하면 이곳에서 보고 투표할 수 있습니다.',
      action: `<a class="btn btn--outline" href="#/admin/submissions/${attr(project.id)}">제출물 관리로</a>`,
    });
    return;
  }

  const tabs = Array.from(mount.querySelectorAll('[data-tab]'));
  const show = (next) => {
    tab = next;
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'ballot') drawBallot(); else drawResult();
  };
  tabs.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  /* --------------------------------------------------------- 평가하기 -- */

  function drawBallot() {
    const mine = myBallot();
    body.innerHTML = `
      <div class="notice notice--info" style="margin-bottom:var(--space-4)">
        마음에 드는 제출물을 <strong>투표</strong>로 고르세요. 순위를 매기고 싶으면
        <strong>순위</strong>까지 골라 주세요 (1위가 가장 높고 ${MAX_RANK}위까지).
        순위는 <strong>한 번씩만</strong> 쓸 수 있고, 매기지 않아도 표는 그대로 셉니다.
        ${mine ? `<br>이미 <strong>${esc(fmtDate(mine.updatedAt, true))}</strong> 에 투표하셨습니다. 다시 내면 덮어씁니다.` : ''}
      </div>

      <div class="eval-grid" id="cards"></div>

      <div class="eval-actions">
        <div class="eval-actions__count">
          선택 <strong data-count>0</strong>건 · 순위 <strong data-ranked>0</strong>건
        </div>
        <div class="row">
          <button class="btn btn--quiet" data-clear>선택 지우기</button>
          <button class="btn btn--primary btn--lg" data-submit>투표 완료</button>
        </div>
      </div>`;

    const grid = body.querySelector('#cards');
    grid.innerHTML = subs.map(cardHtml).join('');

    subs.forEach((s) => { fillMedia(grid, s); });

    grid.querySelectorAll('[data-pick]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.dataset.pick;
        if (box.checked) picks.set(id, picks.get(id) ?? null);
        else picks.delete(id);
        syncCard(grid, id);
        syncCount();
      });
    });

    grid.querySelectorAll('[data-rank]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const id = sel.dataset.rank;
        const rank = sel.value ? Number(sel.value) : null;

        // 같은 순위를 두 곳에 줄 수는 없습니다. 앞서 쓰던 쪽에서 조용히 뺍니다.
        if (rank) {
          for (const [other, r] of picks) {
            if (other !== id && r === rank) {
              picks.set(other, null);
              syncCard(grid, other);
              toastOk(`${rank}위를 옮겼습니다.`);
            }
          }
        }
        picks.set(id, rank);
        syncCard(grid, id);      // 순위를 매기면 투표한 것으로 봅니다
        syncCount();
      });
    });

    grid.querySelectorAll('[data-zoom]').forEach((el) => {
      el.addEventListener('click', () => {
        lightbox(el.dataset.zoom, el.dataset.kind, el.dataset.name || '');
      });
    });

    body.querySelector('[data-clear]').addEventListener('click', () => {
      picks = new Map();
      drawBallot();
    });

    body.querySelector('[data-submit]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!picks.size) {
        const ok = await confirmModal({
          title: '한 건도 고르지 않았습니다',
          body: '빈 표를 내면 이 프로젝트에 넣었던 내 표가 모두 지워집니다.',
          confirmLabel: '그래도 제출',
        });
        if (!ok) return;
      }
      busy(btn, true, '보내는 중…');
      try {
        const payload = [...picks].map(([submissionId, rank]) => ({ submissionId, rank }));
        await store.saveEvaluation(project.id, payload);
        ballots = await store.listEvaluations({ projectId });
        toastOk('투표가 반영되었습니다.');
        show('result');
      } catch (err) {
        busy(btn, false);
        toastErr(`투표에 실패했습니다 — ${err.message}`);
      }
    });

    subs.forEach((s) => syncCard(grid, s.id));
    syncCount();
  }

  /** 한 카드의 선택 상태를 화면에 반영합니다(체크박스·순위·배지·테두리). */
  function syncCard(grid, id) {
    const card = grid.querySelector(`[data-sub="${cssEscape(id)}"]`);
    if (!card) return;
    const chosen = picks.has(id);
    const rank = picks.get(id) ?? null;

    card.classList.toggle('is-picked', chosen);
    const box = card.querySelector('[data-pick]');
    if (box) box.checked = chosen;
    const sel = card.querySelector('[data-rank]');
    if (sel) sel.value = rank ? String(rank) : '';
    const tag = card.querySelector('[data-tag]');
    if (tag) {
      tag.hidden = !rank;
      tag.textContent = rank ? `${rank}위` : '';
    }
  }

  function syncCount() {
    const ranked = [...picks.values()].filter(Boolean).length;
    body.querySelector('[data-count]').textContent = String(picks.size);
    body.querySelector('[data-ranked]').textContent = String(ranked);
  }

  /* ------------------------------------------------------------- 결과 -- */

  function drawResult() {
    const { rows, ranked } = tally(subs, ballots);
    const voters = ballots.length;
    const totalVotes = rows.reduce((n, r) => n + r.votes, 0);
    const top = Math.max(1, ...rows.map((r) => (ranked ? r.points : r.votes)));

    body.innerHTML = `
      <div class="stat-row" style="margin-bottom:var(--space-4)">
        <div class="stat"><div class="stat__v">${voters}</div><div class="stat__k">투표한 관리자</div></div>
        <div class="stat"><div class="stat__v">${totalVotes}</div><div class="stat__k">들어온 표</div></div>
        <div class="stat"><div class="stat__v">${subs.length}</div><div class="stat__k">제출물</div></div>
        <div class="stat"><div class="stat__v">${rows.filter((r) => r.votes).length}</div><div class="stat__k">득표한 제출물</div></div>
      </div>

      ${voters ? '' : `<div class="notice notice--warn" style="margin-bottom:var(--space-4)">
        아직 아무도 투표하지 않았습니다. <strong>평가하기</strong> 탭에서 먼저 투표해 주세요.
      </div>`}

      <div class="notice notice--info" style="margin-bottom:var(--space-4)">
        ${ranked
    ? `순위를 매긴 표가 있어 <strong>순위표</strong>로 보여드립니다 —
           순위 점수는 1위 ${MAX_RANK}점 · 2위 ${MAX_RANK - 1}점 … ${MAX_RANK}위 1점이고,
           점수가 같으면 득표수, 그것도 같으면 먼저 낸 쪽이 앞섭니다.`
    : '아직 순위를 매긴 표가 없어 <strong>득표수</strong>로만 줄을 세웠습니다. 순위를 매겨 투표하면 순위 점수까지 함께 나옵니다.'}
      </div>

      <div class="card">
        <div class="page-head" style="margin-bottom:var(--space-3)">
          <h2 class="page-title" style="font-size:2rem">투표 결과</h2>
          <div class="row">
            <button class="btn btn--outline btn--sm" data-csv>CSV 내려받기</button>
            <button class="btn btn--quiet btn--sm" data-revote>내 투표 수정</button>
            ${voters ? '<button class="btn btn--quiet btn--sm" data-reset style="color:var(--red)">전체 초기화</button>' : ''}
          </div>
        </div>

        <div class="tablewrap">
          <table class="table">
            <thead>
              <tr><th>순위</th><th>제출물</th><th>제출자</th><th>득표</th>
                  ${ranked ? '<th>순위점수</th><th>받은 순위</th>' : ''}<th>투표자</th></tr>
            </thead>
            <tbody>
              ${rows.map((r) => `
                <tr${r.place === 1 ? ' class="is-top"' : ''}>
                  <td class="num">${r.place ? `<span class="place">${r.place}</span>` : '—'}</td>
                  <td>
                    <a href="#/s/${attr(r.sub.id)}">${esc(r.sub.title)}</a>
                    <div class="result-bar"><span style="width:${
  Math.round(((ranked ? r.points : r.votes) / top) * 100)}%"></span></div>
                  </td>
                  <td>${esc(r.sub.author?.institution || '—')} / ${esc(r.sub.author?.name || '—')}</td>
                  <td class="num">${r.votes}</td>
                  ${ranked ? `<td class="num">${r.points}</td>
                    <td>${r.ranks.length ? esc(countRanks(r.ranks)) : '—'}</td>` : ''}
                  <td>${r.voters.length
    ? esc(r.voters.map((v) => (v.rank ? `${v.name}(${v.rank}위)` : v.name)).join(', '))
    : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    body.querySelector('[data-revote]').addEventListener('click', () => {
      picks = new Map((myBallot()?.picks || []).map((p) => [p.submissionId, p.rank ?? null]));
      show('ballot');
    });

    const reset = body.querySelector('[data-reset]');
    if (reset) {
      reset.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: '투표를 전부 지울까요?',
          body: `"${project.title}" 에 들어온 표 ${voters}장이 모두 사라집니다. 되돌릴 수 없습니다.`,
          confirmLabel: '초기화', danger: true, requireText: '초기화',
        });
        if (!ok) return;
        try {
          await store.deleteEvaluation(project.id, { all: true });
          ballots = await store.listEvaluations({ projectId });
          picks = new Map();
          toastOk('투표를 초기화했습니다.');
          drawResult();
        } catch (e) { toastErr(e.message); }
      });
    }

    body.querySelector('[data-csv]').addEventListener('click', () => {
      const header = ['순위', '제목', '기관명', '성명', '이메일', '득표수', '순위점수', '받은 순위', '투표자', '제출ID'];
      const lines = [header.map(csvCell).join(',')];
      rows.forEach((r) => {
        lines.push([
          r.place || '',
          r.sub.title || '',
          r.sub.author?.institution || '',
          r.sub.author?.name || '',
          r.sub.author?.email || '',
          r.votes,
          r.points,
          countRanks(r.ranks),
          r.voters.map((v) => (v.rank ? `${v.name}(${v.rank}위)` : v.name)).join(' | '),
          r.sub.id,
        ].map(csvCell).join(','));
      });
      downloadBlob(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
        `평가결과_${project.title.slice(0, 20)}_${new Date().toISOString().slice(0, 10)}.csv`);
      toastOk('CSV 를 내려받았습니다.');
    });
  }

  show(tab);
}

/* ------------------------------------------------------------ 카드 조각 -- */

function cardHtml(s) {
  const opts = ['<option value="">순위 없음</option>'];
  for (let i = 1; i <= MAX_RANK; i += 1) opts.push(`<option value="${i}">${i}위</option>`);

  return `
    <article class="eval-card" data-sub="${attr(s.id)}">
      <div class="eval-card__media" data-media="${attr(s.id)}">${spinner()}</div>
      <div class="eval-card__body">
        <div class="row" style="gap:8px">
          <h3 class="eval-card__title">${esc(s.title)}</h3>
          <span class="badge badge--gold" data-tag hidden></span>
        </div>
        <p class="eval-card__meta">
          ${esc(s.author?.institution || '—')} · ${esc(s.author?.name || '—')} ·
          ${esc(fmtDate(s.createdAt, true))}
        </p>
        <p class="eval-card__desc">${esc(String(s.body || '').slice(0, 300))}</p>
        <div class="eval-card__links" data-links="${attr(s.id)}"></div>
      </div>
      <div class="eval-card__vote">
        <label class="check" style="padding:0">
          <input type="checkbox" data-pick="${attr(s.id)}" />
          <span>투표</span>
        </label>
        <label class="eval-rank">
          <span class="sr-only">${attr(s.title)} 순위</span>
          <select class="select" data-rank="${attr(s.id)}">${opts.join('')}</select>
        </label>
        <a class="btn btn--quiet btn--sm" href="#/s/${attr(s.id)}">상세</a>
      </div>
    </article>`;
}

/**
 * 카드의 미리보기 자리를 채웁니다.
 * 첨부 주소는 저장소마다 만드는 방식이 달라 비동기입니다 — 카드를 먼저 그리고
 * 주소가 나오는 대로 채워 넣습니다.
 */
async function fillMedia(grid, s) {
  const pane = grid.querySelector(`[data-media="${cssEscape(s.id)}"]`);
  const links = grid.querySelector(`[data-links="${cssEscape(s.id)}"]`);
  if (!pane) return;

  const resolved = [];
  for (const f of s.files || []) {
    resolved.push({ file: f, url: await store.fileURL(f), kind: kindOf(f) });
  }

  const visual = resolved.filter((r) => r.url && (r.kind === 'image' || r.kind === 'video'));
  const pdf = resolved.find((r) => r.url && r.kind === 'pdf');
  const site = firstUrl(s.body);

  if (visual.length) {
    pane.className = `eval-card__media${visual.length > 1 ? ' eval-card__media--multi' : ''}`;
    pane.innerHTML = visual.map((r) => (r.kind === 'video'
      ? `<video src="${attr(r.url)}" controls preload="metadata" playsinline></video>`
      : `<img src="${attr(r.url)}" alt="${attr(r.file.name)}" loading="lazy"
             data-zoom="${attr(r.url)}" data-kind="image" data-name="${attr(r.file.name)}" />`
    )).join('');
  } else if (pdf) {
    pane.innerHTML = `<iframe class="eval-frame" src="${attr(pdf.url)}#view=FitH"
        title="${attr(pdf.file.name)} 미리보기" loading="lazy"></iframe>`;
  } else if (site) {
    pane.innerHTML = framePreview(site);
  } else {
    pane.innerHTML = `<div class="eval-card__none">${
      resolved.length ? '미리볼 수 있는 형식이 아닙니다' : '첨부와 링크가 없습니다'
    }</div>`;
  }

  if (!links) return;
  const chips = [];
  if (site) {
    chips.push(`<a class="btn btn--outline btn--sm" href="${attr(site)}"
      target="_blank" rel="noopener noreferrer">사이트 열기 ↗</a>`);
  }
  for (const r of resolved) {
    const dl = downloadLink(r.url, r.file);
    chips.push(dl
      ? `<a class="btn btn--quiet btn--sm" href="${attr(dl.href)}" ${dl.attrs}
          title="${attr(fmtBytes(r.file.size))}">${esc(r.file.name)}</a>`
      : `<span class="btn btn--quiet btn--sm" aria-disabled="true">${esc(r.file.name)}</span>`);
  }
  links.innerHTML = chips.join('');
}

/**
 * 제출자가 적어 낸 사이트의 미리보기.
 *
 * 우리 도메인의 주소는 프레임에 넣지 않습니다 — 제출자가 적은 주소를 그대로
 * 띄우는 자리라, 같은 오리진이면 그 안의 스크립트가 우리 화면을 만질 수 있기
 * 때문입니다. 바깥 사이트는 교차 오리진이라 그럴 수 없습니다. 다만 프레임을
 * 거부하는 사이트가 많으므로 "열리지 않으면 새 창" 안내를 함께 답니다.
 */
function framePreview(url) {
  let external = false;
  try { external = new URL(url).origin !== window.location.origin; } catch { external = false; }

  if (!external) {
    return `<div class="eval-card__none">
      <a href="${attr(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>
    </div>`;
  }
  return `
    <iframe class="eval-frame" src="${attr(url)}" title="제출한 사이트 미리보기"
            loading="lazy" referrerpolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
    <p class="eval-card__hint">화면이 비어 있으면 그 사이트가 미리보기를 막은 것입니다 — 아래 <strong>사이트 열기</strong>로 새 창에서 보세요.</p>`;
}

/** [1,1,3] → "1위×2, 3위×1" */
function countRanks(ranks) {
  const seen = new Map();
  for (const r of [...ranks].sort((a, b) => a - b)) seen.set(r, (seen.get(r) || 0) + 1);
  return [...seen].map(([r, c]) => `${r}위×${c}`).join(', ');
}

const sameEmail = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** 선택자에 넣을 ID 를 안전하게 감쌉니다(CSS.escape 가 없는 환경 대비). */
function cssEscape(v) {
  const s = String(v);
  return window.CSS?.escape ? window.CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
