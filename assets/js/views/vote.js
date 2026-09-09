/**
 * 상호 투표 — 회원이 서로의 제출물에 표를 줍니다.
 *
 * 표 자체는 저장소가 관리합니다(R2 모드에서는 서버). 이 화면은 집계와
 * "내가 넣은 표"만 받아 그리고, 넣을 수 있는지 여부는 저장소가 다시 봅니다.
 */
import {
  store, votingOf, votingPhase, votableSubmission, VOTE_PHASE_LABEL,
} from '../store/index.js';
import { esc, attr, fmtDate, kindOf } from '../utils.js';
import { spinner, emptyState, toastOk, toastErr } from '../ui.js';
import { currentUser, isAdmin } from '../auth.js';

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

/* ------------------------------------------------------------ 목록 -- */

export async function voteHomeView(mount) {
  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <div class="page-head">
          <div>
            <h1 class="page-title">과제 투표</h1>
            <p class="page-sub">제출된 과제를 함께 보고, 마음에 드는 작품에 표를 주세요.</p>
          </div>
          ${isAdmin() ? '<a class="btn btn--outline" href="#/admin">관리자</a>' : ''}
        </div>
        <div id="voteList">${spinner()}</div>
      </div>
    </section>`;

  const holder = mount.querySelector('#voteList');
  try {
    const projects = (await store.listProjects()).filter((p) => votingOf(p));
    if (!projects.length) {
      holder.innerHTML = emptyState({
        title: '진행중인 투표가 없습니다',
        body: isAdmin()
          ? '프로젝트 편집 화면에서 "회원 상호 투표를 받습니다"를 켜면 이곳에 나타납니다.'
          : '관리자가 투표를 열면 이곳에 표시됩니다.',
        action: isAdmin() ? '<a class="btn btn--primary" href="#/admin">프로젝트 관리로</a>' : '',
      });
      return;
    }

    const groups = [
      ['open', '진행중인 투표'],
      ['before', '시작 예정'],
      ['closed', '마감된 투표'],
    ];

    holder.innerHTML = groups.map(([phase, label]) => {
      const rows = projects.filter((p) => votingPhase(p) === phase);
      if (!rows.length) return '';
      return `
        <h2 style="margin-bottom:var(--space-3);font-size:1.9rem;color:var(--text-black-soft)">
          ${esc(label)} <span style="font-weight:400">(${rows.length})</span>
        </h2>
        <div class="grid" style="margin-bottom:var(--space-6)">
          ${rows.map(voteProjectCard).join('')}
        </div>`;
    }).join('');
  } catch (e) {
    holder.innerHTML = `<div class="notice notice--err">투표 목록을 불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

function voteProjectCard(p) {
  const cfg = votingOf(p);
  const phase = votingPhase(p);
  return `
    <a class="tile" href="#/vote/${attr(p.id)}">
      <div class="tile__cap${phase === 'open' ? '' : ' tile__cap--closed'}"></div>
      <div class="tile__body">
        <div class="row" style="gap:6px">
          <span class="badge ${PHASE_BADGE[phase]}">${esc(VOTE_PHASE_LABEL[phase])}</span>
          <span class="badge badge--gold">1인 ${esc(cfg.perMember)}표</span>
        </div>
        <h3 class="tile__title">${esc(p.title)}</h3>
        <p class="tile__desc">${esc(p.description || '설명이 없습니다.')}</p>
        <div class="tile__foot">
          <span class="badge badge--soft">${esc(periodText(cfg))}</span>
          <span style="color:var(--green-accent);font-weight:600;font-size:1.4rem">
            ${phase === 'open' ? '투표하기 →' : '결과 보기 →'}
          </span>
        </div>
      </div>
    </a>`;
}

/* ------------------------------------------------------ 프로젝트 투표 -- */

export async function voteProjectView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const project = await store.getProject(id);
  if (!project) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '프로젝트를 찾을 수 없습니다',
      body: '삭제되었거나 주소가 잘못되었습니다.',
      action: '<a class="btn btn--outline" href="#/vote">투표 목록으로</a>',
    })}</div></section>`;
    return;
  }

  const cfg = votingOf(project);
  if (!cfg) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '투표를 받지 않는 프로젝트입니다',
      body: isAdmin()
        ? '프로젝트 편집 화면에서 투표를 켜면 이곳에서 표를 받을 수 있습니다.'
        : '관리자가 투표를 열면 이곳에서 표를 줄 수 있습니다.',
      action: isAdmin()
        ? `<a class="btn btn--primary" href="#/admin/project/${attr(project.id)}">프로젝트 편집</a>`
        : '<a class="btn btn--outline" href="#/vote">투표 목록으로</a>',
    })}</div></section>`;
    return;
  }

  const phase = votingPhase(project);
  mount.innerHTML = `
    <section class="band" style="padding-block:var(--space-6)">
      <div class="wrap">
        <p class="crumb" style="color:var(--text-white-soft)">
          <a href="#/vote" style="color:#fff">과제 투표</a><span>/</span>${esc(project.title)}
        </p>
        <div class="row" style="gap:6px;margin-bottom:var(--space-3)">
          <span class="badge ${PHASE_BADGE[phase]}">${esc(VOTE_PHASE_LABEL[phase])}</span>
          <span class="badge badge--gold">1인 ${esc(cfg.perMember)}표</span>
        </div>
        <h1 style="font-size:3.2rem;color:#fff;font-weight:600">${esc(project.title)}</h1>
        <p style="color:var(--text-white-soft);margin-top:var(--space-2);font-size:1.6rem">
          투표 기간 ${esc(periodText(cfg))}
        </p>
        <div class="row" style="margin-top:var(--space-4)">
          <a class="btn btn--ghostDark btn--lg" href="#/p/${attr(project.id)}">과제 안내 보기</a>
          <a class="btn btn--ghostDark btn--lg" href="#/vote">다른 투표 보기</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div id="voteStatus" style="margin-bottom:var(--space-4)"></div>
        <div id="voteBoard">${spinner()}</div>
      </div>
    </section>`;

  const statusEl = mount.querySelector('#voteStatus');
  const boardEl = mount.querySelector('#voteBoard');
  const me = currentUser();

  let subs = [];
  let summary = null;
  /** 투표판에서 뺀 '마감 후 등록' 제출물 수 — 관리자에게만 알려줍니다. */
  let lateNote = 0;

  try {
    [subs, summary] = await Promise.all([
      store.listSubmissions({ projectId: project.id }),
      store.voteSummary(project.id),
    ]);
    // 마감 뒤에 등록된 제출물은 투표판에 올리지 않습니다 — 같은 기간에 맞춰 낸
    // 작품들과 나란히 겨루는 것이 아니기 때문입니다(store/voting.js).
    const lateCount = subs.length - subs.filter(votableSubmission).length;
    subs = subs.filter(votableSubmission);
    if (lateCount) lateNote = lateCount;
  } catch (e) {
    boardEl.innerHTML = `<div class="notice notice--err">투표 정보를 불러오지 못했습니다 — ${esc(e.message)}</div>`;
    return;
  }

  if (!subs.length) {
    statusEl.innerHTML = '';
    boardEl.innerHTML = emptyState({
      title: lateNote ? '투표할 수 있는 제출물이 없습니다' : '아직 제출물이 없습니다',
      body: lateNote
        ? `등록된 ${lateNote}건은 모두 마감 뒤에 들어와 투표 대상에서 빠졌습니다.`
        : '과제가 제출되면 이곳에서 투표할 수 있습니다.',
      action: `<a class="btn btn--outline" href="#/p/${attr(project.id)}">프로젝트 보기</a>`,
    });
    return;
  }

  const stat = (v, k) =>
    `<div class="stat"><div class="stat__v">${esc(v)}</div><div class="stat__k">${esc(k)}</div></div>`;

  const drawStatus = () => {
    const left = Math.max(0, summary.limit - summary.used);
    const notes = {
      before: '아직 투표 기간이 아닙니다. 시작되면 표를 줄 수 있습니다.',
      closed: '투표가 마감되었습니다. 결과만 볼 수 있습니다.',
      off: '이 프로젝트는 더 이상 투표를 받지 않습니다.',
    };
    statusEl.innerHTML = `
      <div class="card card--flat">
        <div class="stat-row">
          ${stat(summary.limit, '1인당 표')}
          ${stat(summary.used, '내가 쓴 표')}
          ${stat(left, '남은 표')}
          ${summary.total === null ? '' : stat(summary.total, '전체 표')}
          ${summary.voters === null ? '' : stat(summary.voters, '참여 인원')}
        </div>
        ${notes[phase] ? `<div class="notice notice--warn" style="margin-top:var(--space-3)">${esc(notes[phase])}</div>` : ''}
        ${phase === 'open' && summary.counts === null ? `
          <div class="notice notice--info" style="margin-top:var(--space-3)">
            공정한 투표를 위해 <strong>득표수는 투표가 끝난 뒤</strong> 공개됩니다.
          </div>` : ''}
        ${lateNote && isAdmin() ? `
          <div class="notice notice--info" style="margin-top:var(--space-3)">
            마감 뒤에 등록된 제출물 <strong>${esc(lateNote)}건</strong>은 투표에서 빠졌습니다.
            <a href="#/admin/submissions/${attr(project.id)}">제출물 관리</a>에서 볼 수 있습니다.
          </div>` : ''}
      </div>`;
  };

  /** 같은 표를 받은 작품은 같은 등수 — 1,1,3 처럼 매깁니다. */
  let ranks = new Map();

  /** 집계가 바뀔 때마다 카드 전체를 다시 그립니다. */
  const paint = () => {
    const counts = summary.counts || {};
    const ranked = [...subs];
    // 득표가 공개된 상태에서는 많이 받은 순으로 — 마감 뒤 결과 화면이 됩니다.
    if (summary.counts) {
      ranked.sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0)
        || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    }

    ranks = new Map();
    let prev = null;
    let prevRank = 0;
    ranked.forEach((s, i) => {
      const c = counts[s.id] || 0;
      if (c !== prev) { prevRank = i + 1; prev = c; }
      ranks.set(s.id, prevRank);
    });

    boardEl.innerHTML = `
      <div class="page-head" style="margin-bottom:var(--space-3)">
        <h2 class="page-title" style="font-size:2rem">
          제출물 <span style="font-weight:400;color:var(--text-black-soft)">${ranked.length}</span>
        </h2>
        ${isAdmin() ? `<a class="btn btn--quiet btn--sm" href="#/admin/submissions/${attr(project.id)}">관리 화면</a>` : ''}
      </div>
      <div class="votegrid">${ranked.map(cardHtml).join('')}</div>`;

    boardEl.querySelectorAll('[data-vote]').forEach((btn) => {
      btn.addEventListener('click', () => cast(btn.dataset.vote, btn.dataset.on === '1', btn));
    });
    loadThumbs();
  };

  const cardHtml = (s) => {
    const counts = summary.counts || {};
    const picked = summary.mine.includes(s.id);
    const mine = Boolean(me && s.author?.email && s.author.email === me.email);
    const noSelf = mine && !summary.allowSelf;
    const outOfVotes = !picked && summary.used >= summary.limit;
    const votable = phase === 'open' && !noSelf;
    const rank = summary.counts ? ranks.get(s.id) : null;

    let action = '';
    if (!votable) {
      action = noSelf
        ? '<span class="badge badge--soft">내 제출물</span>'
        : '<span class="badge badge--closed">투표 불가</span>';
    } else if (picked) {
      action = `<button class="btn btn--outline btn--sm" data-vote="${attr(s.id)}" data-on="0">
                  투표 취소</button>`;
    } else {
      action = `<button class="btn btn--primary btn--sm" data-vote="${attr(s.id)}" data-on="1"
                        ${outOfVotes ? 'disabled title="남은 표가 없습니다"' : ''}>
                  투표하기</button>`;
    }

    return `
      <article class="votecard${picked ? ' votecard--picked' : ''}" data-card="${attr(s.id)}">
        <div class="votecard__thumb" data-thumb="${attr(s.id)}">
          <span style="font-size:1.3rem;color:var(--text-black-mute);font-weight:700">
            ${(s.files || []).length ? '첨부 미리보기' : '첨부 없음'}</span>
        </div>
        <div class="votecard__body">
          <div class="row" style="gap:6px">
            ${rank && (counts[s.id] || 0) > 0 ? `<span class="badge badge--gold">${rank}위</span>` : ''}
            ${picked ? '<span class="badge badge--open">내가 투표함</span>' : ''}
            ${mine ? '<span class="badge badge--soft">내 제출물</span>' : ''}
          </div>
          <h3 class="votecard__title">
            <a href="#/s/${attr(s.id)}" style="color:inherit">${esc(s.title)}</a>
          </h3>
          <p class="votecard__meta">
            ${esc(s.author?.institution || '—')} · ${esc(s.author?.name || '—')}
            · 첨부 ${(s.files || []).length}건
          </p>
        </div>
        <div class="votecard__foot">
          <span class="votecard__count">
            ${summary.counts ? `${esc(counts[s.id] || 0)}표` : '<span style="color:var(--text-black-mute);font-size:1.4rem;font-weight:400">집계 비공개</span>'}
          </span>
          ${action}
        </div>
      </article>`;
  };

  /** 이미지·영상 첨부가 있으면 첫 장을 카드 썸네일로 씁니다. */
  const loadThumbs = async () => {
    for (const s of subs) {
      const holder = boardEl.querySelector(`[data-thumb="${CSS.escape(s.id)}"]`);
      if (!holder) continue;
      const file = (s.files || []).find((f) => ['image', 'video'].includes(kindOf(f)));
      if (!file) continue;
      const url = await store.fileURL(file);
      if (!url || !holder.isConnected) continue;
      holder.innerHTML = kindOf(file) === 'image'
        ? `<img src="${attr(url)}" alt="${attr(s.title)}" loading="lazy" />`
        : `<video src="${attr(url)}" preload="metadata" muted></video>`;
    }
  };

  const cast = async (submissionId, on, btn) => {
    btn.disabled = true;
    try {
      summary = await store.castVote(submissionId, on);
      toastOk(on ? '투표했습니다.' : '투표를 취소했습니다.');
      drawStatus();
      paint();
    } catch (e) {
      btn.disabled = false;
      toastErr(e.message);
    }
  };

  drawStatus();
  paint();
}
