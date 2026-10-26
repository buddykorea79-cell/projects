/**
 * AI Build Camp — 조별 제출물과 발표 평가.
 *
 * 화면은 두 장입니다.
 *   · 조별 제출물 : 1조~8조가 낸 과제. 그룹장은 자기 조에서 발표 과제를 뽑습니다.
 *   · 발표 평가   : 선정된 발표에 세 문항으로 점수를 줍니다(합계 40점).
 *
 * 누가 무엇을 볼 수 있고 누를 수 있는지는 `assets/js/camp.js` 의 규칙을
 * 그대로 씁니다. 실제 허용 여부는 저장소(R2 모드에서는 서버)가 다시 봅니다.
 */
import { store, submissionOpen } from '../store/index.js';
import {
  isCamp, teamLabel, normTeam, teamRows, isNominee, canNominate,
  presentationOf, presentationPhase, PRESENT_PHASE_LABEL,
  RUBRIC, RUBRIC_TOTAL, scoreBlock, myTeamIn, normScore, TRACK_LABEL,
} from '../camp.js';
import { esc, attr, fmtDate, normEmail, downloadBlob } from '../utils.js';
import { buildXlsx } from '../sheet.js';
import { spinner, emptyState, toastOk, toastErr, busy } from '../ui.js';
import { currentUser, isAdmin, myLeaderTeam, refreshRole } from '../auth.js';

const PHASE_BADGE = {
  open: 'badge--open',
  before: 'badge--soft',
  closed: 'badge--closed',
  off: 'badge--closed',
};

/** "2026-09-01 09:00 ~ 09-07 18:00" 같은 기간 문구. */
function periodText(cfg) {
  if (!cfg) return '—';
  if (!cfg.startAt && !cfg.endAt) return '상시';
  const from = cfg.startAt ? fmtDate(cfg.startAt, true) : '지금부터';
  const to = cfg.endAt ? fmtDate(cfg.endAt, true) : '마감일 없음';
  return `${from} ~ ${to}`;
}

/** 점수를 소수 한 자리까지. 정수면 소수점을 붙이지 않습니다. */
const pt = (n) => (Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1));

/* ============================================================ 목록 == */

export async function campHomeView(mount) {
  // 방금 그룹장이 된 사람도 바로 알아보도록 권한을 다시 확인합니다.
  await refreshRole();
  const admin = isAdmin();
  const myTeam = myLeaderTeam();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <div class="page-head">
          <div>
            <h1 class="page-title">Build Camp</h1>
            <p class="page-sub">
              AI Build Camp 과제를 조별로 보고, 선정된 발표에 점수를 줍니다.
            </p>
          </div>
          ${admin ? '<a class="btn btn--outline" href="#/admin">관리자</a>' : ''}
        </div>

        ${myTeam ? `
          <div class="notice notice--info" style="margin-bottom:var(--space-4)">
            <span><strong>${esc(teamLabel(myTeam))} 그룹장</strong>입니다 —
            우리 조가 낸 과제를 모두 볼 수 있고, 그 중에서 발표 과제를 하나 뽑습니다.</span>
          </div>` : ''}

        <div id="campList">${spinner()}</div>
      </div>
    </section>`;

  const holder = mount.querySelector('#campList');
  try {
    const [projects, subs] = await Promise.all([
      store.listProjects(),
      store.listSubmissions().catch(() => []),
    ]);
    const camps = projects.filter(isCamp);

    if (!camps.length) {
      holder.innerHTML = emptyState({
        title: 'AI Build Camp 과제가 없습니다',
        body: admin
          ? '프로젝트를 개설할 때 과제 종류를 "AI Build Camp" 로 고르면 이곳에 나타납니다.'
          : '관리자가 Build Camp 과제를 개설하면 이곳에 표시됩니다.',
        action: admin ? '<a class="btn btn--primary" href="#/admin/project/new">프로젝트 개설</a>' : '',
      });
      return;
    }

    holder.innerHTML = `<div class="grid">${camps.map((p) => {
      const here = subs.filter((s) => s.projectId === p.id);
      const phase = presentationPhase(p);
      const open = submissionOpen(p);
      // 선정된 발표는 모두에게 보이므로 건수를 그대로 쓸 수 있습니다. 전체 제출
      // 건수는 **관리자에게만** 정확합니다(그 밖에는 볼 수 있는 것만 세집니다).
      const nominees = here.filter(isNominee).length;
      return `
        <a class="tile" href="#/camp/${attr(p.id)}">
          <div class="tile__cap${open ? '' : ' tile__cap--closed'}"></div>
          <div class="tile__body">
            <div class="row" style="gap:6px">
              <span class="badge ${open ? 'badge--open' : 'badge--closed'}">${open ? '접수중' : '접수 마감'}</span>
              ${phase === 'off' ? '' : `<span class="badge ${PHASE_BADGE[phase]}">${esc(PRESENT_PHASE_LABEL[phase])}</span>`}
            </div>
            <h3 class="tile__title">${esc(p.title)}</h3>
            <p class="tile__desc">${esc(p.description || '설명이 없습니다.')}</p>
            <div class="tile__foot">
              <span class="badge badge--soft">${esc(admin
                ? [`제출 ${here.length}건`, nominees ? `발표 ${nominees}건` : ''].filter(Boolean).join(' · ')
                : (nominees ? `발표 ${nominees}건` : '발표 선정 전'))}</span>
              <span style="color:var(--green-accent);font-weight:600;font-size:1.4rem">열기 →</span>
            </div>
          </div>
        </a>`;
    }).join('')}</div>`;
  } catch (e) {
    holder.innerHTML = `<div class="notice notice--err">Build Camp 과제를 불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

/* ====================================================== 과제 한 건 == */

const TABS = [
  { id: 'teams', label: '조별 제출물' },
  { id: 'judge', label: '발표 평가' },
];

export async function campProjectView(mount, { id }, query) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const project = await store.getProject(id);
  if (!project || !isCamp(project)) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: project ? 'AI Build Camp 과제가 아닙니다' : '과제를 찾을 수 없습니다',
      body: project
        ? `이 과제는 "${TRACK_LABEL.general}" 입니다. 프로젝트 화면에서 보세요.`
        : '삭제되었거나 주소가 잘못되었습니다.',
      action: project
        ? `<a class="btn btn--outline" href="#/p/${attr(project.id)}">프로젝트로</a>`
        : '<a class="btn btn--outline" href="#/camp">Build Camp 목록으로</a>',
    })}</div></section>`;
    return;
  }

  // 그룹장인지에 따라 보이는 것이 달라지므로 그리기 전에 권한을 다시 확인합니다.
  await refreshRole();

  const tabId = TABS.some((t) => t.id === query?.get('tab')) ? query.get('tab') : 'teams';
  const cfg = presentationOf(project);
  const phase = presentationPhase(project);
  const admin = isAdmin();
  const open = submissionOpen(project);

  mount.innerHTML = `
    <section class="band" style="padding-block:var(--space-6)">
      <div class="wrap">
        <p class="crumb" style="color:var(--text-white-soft)">
          <a href="#/camp" style="color:#fff">Build Camp</a><span>/</span>${esc(project.title)}
        </p>
        <div class="row" style="gap:6px;margin-bottom:var(--space-3)">
          <span class="badge ${open ? 'badge--open' : 'badge--closed'}">${open ? '접수중' : '접수 마감'}</span>
          ${cfg ? `<span class="badge ${PHASE_BADGE[phase]}">${esc(PRESENT_PHASE_LABEL[phase])}</span>` : ''}
          <span class="badge badge--gold">${esc(TRACK_LABEL.buildcamp)}</span>
        </div>
        <h1 style="font-size:3.2rem;color:#fff;font-weight:600">${esc(project.title)}</h1>
        <p style="color:var(--text-white-soft);margin-top:var(--space-2);font-size:1.6rem">
          제출 마감 ${esc(fmtDate(project.dueAt, true))}${project.dueAt ? '' : ' — 상시 접수'}
          ${cfg ? ` · 발표 평가 ${esc(periodText(cfg))}` : ''}
        </p>
        <div class="row" style="margin-top:var(--space-4)">
          ${open
            ? `<a class="btn btn--onDark btn--lg" href="#/p/${attr(project.id)}/submit">과제 제출하기</a>`
            : admin
              ? `<a class="btn btn--onDark btn--lg" href="#/p/${attr(project.id)}/submit">관리자로 등록하기</a>`
              : ''}
          <a class="btn btn--ghostDark btn--lg" href="#/p/${attr(project.id)}">과제 안내 보기</a>
          ${admin ? `<a class="btn btn--ghostDark btn--lg" href="#/admin/scores/${attr(project.id)}">발표 평가 결과</a>` : ''}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <nav class="subnav" aria-label="Build Camp 메뉴">
          ${TABS.map((t) => `
            <a class="subnav__item${t.id === tabId ? ' is-active' : ''}"
               href="#/camp/${attr(project.id)}?tab=${attr(t.id)}"
               ${t.id === tabId ? 'aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')}
        </nav>
        <div id="campBody">${spinner()}</div>
      </div>
    </section>`;

  const body = mount.querySelector('#campBody');
  try {
    const subs = await store.listSubmissions({ projectId: project.id });
    if (tabId === 'judge') await renderJudge(body, project, subs);
    else await renderTeams(body, project, subs);
  } catch (e) {
    body.innerHTML = `<div class="notice notice--err">내용을 불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------ 조별 제출물 -- */

async function renderTeams(mount, project, subs) {
  const me = currentUser();
  const admin = isAdmin();
  const myTeam = myLeaderTeam();
  // 관리자는 모든 조, 그룹장은 자기 조. 그 밖에는 자기가 낸 것만 보입니다.
  const wide = admin || myTeam > 0;
  const rows = teamRows(subs);
  const unassigned = subs.filter((s) => !normTeam(s.team));

  const draw = () => {
    const visible = admin ? rows : rows.filter((r) => r.team === myTeam);

    mount.innerHTML = `
      ${wide ? `
        <div class="card card--flat" style="margin-bottom:var(--space-4)">
          <h2 class="page-title" style="font-size:1.9rem;margin-bottom:var(--space-3)">조별 현황</h2>
          <div class="tablewrap">
            <table class="table">
              <thead><tr><th>조</th><th class="num">제출</th><th>발표 과제</th></tr></thead>
              <tbody>
                ${(admin ? rows : visible).map((r) => `
                  <tr${r.team === myTeam ? ' style="background:var(--green-light)"' : ''}>
                    <td><strong>${esc(r.label)}</strong>${r.team === myTeam ? ' <span class="badge badge--gold">우리 조</span>' : ''}</td>
                    <td class="num">${esc(r.count)}</td>
                    <td>${r.nominee
                      ? `<a href="#/s/${attr(r.nominee.id)}">${esc(r.nominee.title)}</a>`
                      : '<span style="color:var(--text-black-mute)">아직 없음</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          ${admin && unassigned.length ? `
            <div class="notice notice--warn" style="margin-top:var(--space-3)">
              조가 지정되지 않은 제출물이 <strong>${esc(unassigned.length)}건</strong> 있습니다.
              제출물 관리에서 조를 채워 주세요.
            </div>` : ''}
          ${admin ? '' : `
            <p class="field__hint" style="margin-top:var(--space-3)">
              그룹장은 <strong>맡은 조</strong>만 봅니다. 다른 조가 낸 과제는 발표 과제로
              선정된 뒤에 <a href="#/camp/${attr(project.id)}?tab=judge">발표 평가</a> 에서 보입니다.
            </p>`}
        </div>` : ''}

      ${visible.length ? visible.map((r) => teamBlock(r, me, myTeam, project)).join('') : ''}

      ${wide ? '' : `
        <div class="card">
          <h2 class="page-title" style="font-size:1.9rem;margin-bottom:var(--space-3)">내 제출물</h2>
          ${myOwn(subs, me, project)}
        </div>`}`;

    mount.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => pick(btn.dataset.pick, btn.dataset.on === '1', btn));
    });
  };

  const pick = async (submissionId, on, btn) => {
    busy(btn, true, on ? '선정 중…' : '해제 중…');
    try {
      await store.nominate(submissionId, on);
      toastOk(on ? '발표 과제로 선정했습니다.' : '발표 과제 선정을 해제했습니다.');
      // 같은 조의 다른 선정이 함께 내려가므로 목록을 다시 읽습니다.
      const fresh = await store.listSubmissions({ projectId: project.id });
      subs.length = 0;
      subs.push(...fresh);
      rows.length = 0;
      rows.push(...teamRows(subs));
      draw();
    } catch (e) {
      busy(btn, false);
      toastErr(e.message);
    }
  };

  draw();
}

/** 한 조의 제출물 목록. 뽑을 수 있는 사람에게는 선정 버튼이 붙습니다. */
function teamBlock(row, me, myTeam, project) {
  const locked = presentationPhase(project) === 'closed';
  return `
    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="page-head" style="margin-bottom:var(--space-3)">
        <h2 class="page-title" style="font-size:1.9rem">
          ${esc(row.label)}
          <span style="font-weight:400;color:var(--text-black-soft)">${esc(row.count)}건</span>
          ${row.team === myTeam ? '<span class="badge badge--gold">우리 조</span>' : ''}
        </h2>
      </div>
      ${row.rows.length ? `
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>제목</th><th>기관 / 성명</th><th class="num">첨부</th>
                       <th>제출일</th><th></th></tr></thead>
            <tbody>
              ${row.rows.map((s) => {
                const may = canNominate(me, s) && !locked;
                const mine = normEmail(s.author?.email) === normEmail(me?.email);
                return `
                <tr${isNominee(s) ? ' style="background:var(--green-light)"' : ''}>
                  <td>
                    <a href="#/s/${attr(s.id)}">${esc(s.title)}</a>
                    ${isNominee(s) ? ' <span class="badge badge--gold">발표 과제</span>' : ''}
                    ${s.late ? ' <span class="badge badge--due">마감 후 등록</span>' : ''}
                  </td>
                  <td>${esc(s.author?.institution || '—')} / ${esc(s.author?.name || '—')}
                      ${mine ? '<span class="badge badge--soft">나</span>' : ''}</td>
                  <td class="num">${(s.files || []).length}</td>
                  <td>${esc(fmtDate(s.createdAt, true))}</td>
                  <td style="white-space:nowrap">${may ? (isNominee(s)
                    ? `<button class="btn btn--quiet btn--sm" data-pick="${attr(s.id)}" data-on="0">선정 해제</button>`
                    : s.late
                      ? '<span style="color:var(--text-black-mute);font-size:1.3rem">마감 후 등록</span>'
                      : `<button class="btn btn--primary btn--sm" data-pick="${attr(s.id)}" data-on="1">발표 과제로</button>`)
                    : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        ${locked ? `
          <p class="field__hint" style="margin-top:var(--space-2)">
            발표 평가가 마감되어 선정을 바꿀 수 없습니다.
          </p>` : ''}`
      : `<p style="color:var(--text-black-soft);font-size:1.5rem">아직 제출물이 없습니다.</p>`}
    </div>`;
}

/** 일반 회원에게 보여줄 자기 제출물. */
function myOwn(subs, me, project) {
  const mine = subs.filter((s) => normEmail(s.author?.email) === normEmail(me?.email));
  if (!mine.length) {
    return emptyState({
      title: '아직 제출하지 않았습니다',
      body: 'AI Build Camp 과제는 제출할 때 조(1조~8조)를 함께 고릅니다.',
      action: submissionOpen(project)
        ? `<a class="btn btn--primary" href="#/p/${attr(project.id)}/submit">과제 제출하기</a>`
        : '',
    });
  }
  return `
    <div class="tablewrap">
      <table class="table">
        <thead><tr><th>제목</th><th>조</th><th class="num">첨부</th><th>제출일</th></tr></thead>
        <tbody>
          ${mine.map((s) => `
            <tr>
              <td><a href="#/s/${attr(s.id)}">${esc(s.title)}</a>
                  ${isNominee(s) ? ' <span class="badge badge--gold">발표 과제</span>' : ''}</td>
              <td>${esc(teamLabel(s.team))}</td>
              <td class="num">${(s.files || []).length}</td>
              <td>${esc(fmtDate(s.createdAt, true))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="field__hint" style="margin-top:var(--space-3)">
      다른 조가 낸 과제는 발표 과제로 선정된 뒤에 보입니다.
      조별 전체 목록은 그룹장과 관리자가 봅니다.
    </p>`;
}

/* -------------------------------------------------------- 발표 평가 -- */

async function renderJudge(mount, project, subs) {
  const me = currentUser();
  const cfg = presentationOf(project);
  const phase = presentationPhase(project);

  if (!cfg) {
    mount.innerHTML = emptyState({
      title: '발표 평가를 받지 않는 과제입니다',
      body: isAdmin()
        ? '프로젝트 편집 화면에서 "발표 평가를 받습니다" 를 켜면 이곳에서 점수를 받습니다.'
        : '관리자가 발표 평가를 열면 이곳에서 점수를 줄 수 있습니다.',
      action: isAdmin()
        ? `<a class="btn btn--primary" href="#/admin/project/${attr(project.id)}">프로젝트 편집</a>`
        : '',
    });
    return;
  }

  const nominees = subs.filter(isNominee)
    .sort((a, b) => normTeam(a.team) - normTeam(b.team));
  if (!nominees.length) {
    mount.innerHTML = emptyState({
      title: '아직 선정된 발표가 없습니다',
      body: '조마다 그룹장이 발표 과제를 하나 뽑으면 이곳에 올라옵니다.',
      action: `<a class="btn btn--outline" href="#/camp/${attr(project.id)}?tab=teams">조별 제출물 보기</a>`,
    });
    return;
  }

  let summary = await store.scoreSummary(project.id);
  const myTeam = myTeamIn(subs, me);

  const stat = (v, k) =>
    `<div class="stat"><div class="stat__v">${esc(v)}</div><div class="stat__k">${esc(k)}</div></div>`;

  const draw = () => {
    const notes = {
      before: '아직 발표 평가 기간이 아닙니다. 시작되면 점수를 줄 수 있습니다.',
      closed: '발표 평가가 마감되었습니다. 결과만 볼 수 있습니다.',
    };
    mount.innerHTML = `
      <div class="card card--flat" style="margin-bottom:var(--space-4)">
        <div class="stat-row">
          ${stat(nominees.length, '선정된 발표')}
          ${stat(summary.judged, '내가 채점한 수')}
          ${stat(`${RUBRIC_TOTAL}점`, '한 발표 만점')}
          ${summary.judges === null ? '' : stat(summary.judges, '채점 인원')}
        </div>
        ${notes[phase] ? `<div class="notice notice--warn" style="margin-top:var(--space-3)">${esc(notes[phase])}</div>` : ''}
        ${phase === 'open' && !summary.showScores ? `
          <div class="notice notice--info" style="margin-top:var(--space-3)">
            공정한 평가를 위해 <strong>점수는 평가가 끝난 뒤</strong> 공개됩니다.
            ${isAdmin() ? '관리자에게는 지금도 보입니다.' : ''}
          </div>` : ''}
        <div class="rubric-legend">
          ${RUBRIC.map((r) => `
            <div class="rubric-legend__row">
              <strong>${esc(r.label)}</strong>
              <span class="badge badge--soft">${esc(r.max)}점</span>
              <span class="rubric-legend__q">${esc(r.question)}</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="judge-list">
        ${nominees.map((s) => judgeCard(s, project, me, myTeam, summary)).join('')}
      </div>`;

    mount.querySelectorAll('[data-score-form]').forEach(bindForm);
  };

  const bindForm = (form) => {
    const id = form.dataset.scoreForm;
    const totalEl = form.querySelector('[data-total]');
    const retotal = () => {
      const got = {};
      for (const r of RUBRIC) got[r.key] = form.querySelector(`[name="${r.key}"]`).value;
      totalEl.textContent = normScore(got).total;
    };
    form.querySelectorAll('input[type="number"]').forEach((el) => {
      el.addEventListener('input', retotal);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = {};
      for (const r of RUBRIC) input[r.key] = form.querySelector(`[name="${r.key}"]`).value;
      const btn = form.querySelector('button[type="submit"]');
      busy(btn, true, '저장 중…');
      try {
        summary = await store.castScore(id, input);
        toastOk('점수를 저장했습니다.');
        draw();
      } catch (err) {
        busy(btn, false);
        toastErr(err.message);
      }
    });
  };

  draw();
}

/** 발표 하나 — 점수 입력 또는 줄 수 없는 이유. */
function judgeCard(s, project, me, myTeam, summary) {
  const blocked = scoreBlock(project, s, me, myTeam);
  const mine = summary.mine?.[s.id] || null;
  const acc = summary.scores?.[s.id] || null;

  return `
    <article class="judge${mine ? ' judge--done' : ''}">
      <div class="judge__head">
        <div style="min-width:0">
          <div class="row" style="gap:6px">
            <span class="badge badge--gold">${esc(teamLabel(s.team))}</span>
            ${mine ? `<span class="badge badge--open">채점 완료 ${esc(mine.total)}점</span>` : ''}
          </div>
          <h3 class="judge__title"><a href="#/s/${attr(s.id)}">${esc(s.title)}</a></h3>
          <p class="judge__meta">
            ${esc(s.author?.institution || '—')} · ${esc(s.author?.name || '—')}
            · 첨부 ${(s.files || []).length}건
          </p>
        </div>
        ${acc ? `
          <div class="judge__avg">
            <div class="judge__avgv">${esc(pt(acc.avg.total))}<span>/${esc(RUBRIC_TOTAL)}</span></div>
            <div class="judge__avgk">평균 · ${esc(acc.judges)}명 채점</div>
          </div>` : ''}
      </div>

      ${blocked
        ? `<div class="notice notice--warn judge__blocked">${esc(blocked)}</div>`
        : `
        <form class="judge__form" data-score-form="${attr(s.id)}" novalidate>
          ${RUBRIC.map((r) => `
            <label class="judge__row">
              <span class="judge__label">
                <strong>${esc(r.label)}</strong>
                <span class="judge__q">${esc(r.question)}</span>
              </span>
              <span class="judge__input">
                <input class="input" type="number" name="${attr(r.key)}"
                       min="0" max="${attr(r.max)}" step="1" inputmode="numeric"
                       value="${attr(mine ? mine[r.key] : 0)}" />
                <span class="judge__max">/ ${esc(r.max)}점</span>
              </span>
            </label>`).join('')}
          <div class="judge__foot">
            <span class="judge__total">합계 <strong data-total>${esc(mine ? mine.total : 0)}</strong> / ${esc(RUBRIC_TOTAL)}점</span>
            <button class="btn btn--primary btn--sm" type="submit">
              ${mine ? '점수 고치기' : '점수 주기'}</button>
          </div>
        </form>`}

      ${acc ? `
        <div class="judge__break">
          ${RUBRIC.map((r) => `
            <span><span class="judge__breakk">${esc(r.label)}</span>
              <strong>${esc(pt(acc.avg[r.key]))}</strong>/${esc(r.max)}</span>`).join('')}
        </div>` : ''}
    </article>`;
}

/* ====================================================== 결과 (관리자) == */

export async function campResultView(mount, { projectId }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const project = await store.getProject(projectId);
  if (!project || !isCamp(project)) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: 'AI Build Camp 과제가 아닙니다',
      body: '발표 평가 결과는 Build Camp 과제에만 있습니다.',
      action: '<a class="btn btn--outline" href="#/admin">관리자로</a>',
    })}</div></section>`;
    return;
  }

  const [subs, summary, rows] = await Promise.all([
    store.listSubmissions({ projectId: project.id }),
    store.scoreSummary(project.id),
    // 원자료는 관리자만 볼 수 있습니다. 서버 없는 모드에서는 전체 목록을 걸러 씁니다.
    (store.listScores
      ? store.listScores(project.id)
      : Promise.resolve([])).catch(() => []),
  ]);
  const raw = rows.filter((r) => r.projectId === project.id);

  const nominees = subs.filter(isNominee).map((s) => {
    const acc = summary.scores?.[s.id] || null;
    return { sub: s, acc, avg: acc ? acc.avg.total : 0, judges: acc ? acc.judges : 0 };
  }).sort((a, b) => b.avg - a.avg || normTeam(a.sub.team) - normTeam(b.sub.team));

  // 같은 평균은 같은 등수 — 1,1,3 처럼 매깁니다.
  let prev = null;
  let prevRank = 0;
  nominees.forEach((n, i) => {
    if (n.avg !== prev) { prevRank = i + 1; prev = n.avg; }
    n.rank = prevRank;
  });

  const phase = presentationPhase(project);

  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <p class="crumb">
          <a href="#/admin">관리자</a><span>/</span>
          <a href="#/camp/${attr(project.id)}">${esc(project.title)}</a><span>/</span>발표 평가 결과
        </p>
        <div class="page-head">
          <div>
            <h1 class="page-title">발표 평가 결과</h1>
            <p class="page-sub">
              ${esc(project.title)} · ${esc(PRESENT_PHASE_LABEL[phase])}
              ${summary.judges === null ? '' : ` · 채점 인원 ${esc(summary.judges)}명`}
            </p>
          </div>
          <div class="row">
            <button class="btn btn--outline" data-xlsx ${nominees.length ? '' : 'disabled'}>엑셀로 내보내기</button>
            <a class="btn btn--quiet" href="#/camp/${attr(project.id)}?tab=judge">평가 화면</a>
          </div>
        </div>

        ${nominees.length ? `
          <div class="card card--flat" style="margin-bottom:var(--space-4)">
            <div class="tablewrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>순위</th><th>조</th><th>발표 과제</th><th>제출자</th>
                    ${RUBRIC.map((r) => `<th class="num">${esc(r.label)}<br><span style="font-weight:400">(${esc(r.max)}점)</span></th>`).join('')}
                    <th class="num">합계 (${esc(RUBRIC_TOTAL)}점)</th><th class="num">채점</th>
                  </tr>
                </thead>
                <tbody>
                  ${nominees.map((n) => `
                    <tr>
                      <td><strong>${n.judges ? `${esc(n.rank)}위` : '—'}</strong></td>
                      <td>${esc(teamLabel(n.sub.team))}</td>
                      <td><a href="#/s/${attr(n.sub.id)}">${esc(n.sub.title)}</a></td>
                      <td>${esc(n.sub.author?.name || '—')}</td>
                      ${RUBRIC.map((r) => `<td class="num">${n.acc ? esc(pt(n.acc.avg[r.key])) : '—'}</td>`).join('')}
                      <td class="num"><strong>${n.acc ? esc(pt(n.acc.avg.total)) : '—'}</strong></td>
                      <td class="num">${esc(n.judges)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
            <p class="field__hint" style="margin-top:var(--space-3)">
              점수는 <strong>채점한 사람의 평균</strong>입니다 — 채점하지 않은 사람을 0점으로 세지 않습니다.
            </p>
          </div>

          ${raw.length ? `
            <div class="card">
              <h2 class="page-title" style="font-size:1.9rem;margin-bottom:var(--space-3)">
                채점 원자료 <span style="font-weight:400;color:var(--text-black-soft)">${esc(raw.length)}건</span>
              </h2>
              <div class="tablewrap">
                <table class="table">
                  <thead><tr><th>채점자</th><th>발표 과제</th>
                    ${RUBRIC.map((r) => `<th class="num">${esc(r.label)}</th>`).join('')}
                    <th class="num">합계</th><th>채점 시각</th></tr></thead>
                  <tbody>
                    ${raw.map((r) => {
                      const sub = subs.find((s) => s.id === r.submissionId);
                      return `
                      <tr>
                        <td>${esc(r.voter)}</td>
                        <td>${esc(sub ? `${teamLabel(sub.team)} · ${sub.title}` : r.submissionId)}</td>
                        ${RUBRIC.map((item) => `<td class="num">${esc(normScore(r)[item.key])}</td>`).join('')}
                        <td class="num"><strong>${esc(normScore(r).total)}</strong></td>
                        <td>${esc(fmtDate(r.updatedAt || r.createdAt, true))}</td>
                      </tr>`;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>` : ''}`
        : emptyState({
          title: '아직 선정된 발표가 없습니다',
          body: '조마다 그룹장이 발표 과제를 뽑으면 이곳에 결과가 모입니다.',
          action: `<a class="btn btn--outline" href="#/camp/${attr(project.id)}?tab=teams">조별 제출물 보기</a>`,
        })}
      </div>
    </section>`;

  const btn = mount.querySelector('[data-xlsx]');
  btn?.addEventListener('click', () => {
    try {
      const summaryRows = [
        ['순위', '조', '발표 과제', '제출자', '기관',
          ...RUBRIC.map((r) => `${r.label}(${r.max}점)`), `합계(${RUBRIC_TOTAL}점)`, '채점 인원'],
        ...nominees.map((n) => [
          n.judges ? n.rank : '',
          teamLabel(n.sub.team),
          n.sub.title,
          n.sub.author?.name || '',
          n.sub.author?.institution || '',
          ...RUBRIC.map((r) => (n.acc ? Math.round(n.acc.avg[r.key] * 10) / 10 : '')),
          n.acc ? Math.round(n.acc.avg.total * 10) / 10 : '',
          n.judges,
        ]),
      ];
      const rawRows = [
        ['채점자', '조', '발표 과제', ...RUBRIC.map((r) => r.label), '합계', '채점 시각'],
        ...raw.map((r) => {
          const sub = subs.find((s) => s.id === r.submissionId);
          const one = normScore(r);
          return [
            r.voter,
            teamLabel(sub?.team),
            sub?.title || r.submissionId,
            ...RUBRIC.map((item) => one[item.key]),
            one.total,
            fmtDate(r.updatedAt || r.createdAt, true),
          ];
        }),
      ];
      const sheets = [{ name: '발표 평가 결과', rows: summaryRows }];
      if (raw.length) sheets.push({ name: '채점 원자료', rows: rawRows });
      downloadBlob(buildXlsx(sheets),
        `발표평가_${new Date().toISOString().slice(0, 10)}.xlsx`);
      toastOk('엑셀 파일을 내려받았습니다.');
    } catch (e) {
      toastErr(`내보내기 실패 — ${e.message}`);
    }
  });
}
