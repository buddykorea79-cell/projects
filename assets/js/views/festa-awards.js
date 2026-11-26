/** 최종 시상 검토·발행 및 공개 시상식 화면. 공개 화면은 발행 스냅샷만 읽습니다. */
import { CONFIG } from '../config.js';
import { store } from '../store/index.js';
import { currentUser, isAdmin } from '../auth.js';
import { currentPath, currentQuery } from '../router.js';
import { esc, attr } from '../utils.js';
import { confirmModal, spinner, emptyState, toastOk, toastErr } from '../ui.js';
import { downloadTallyResultPdf } from '../pdf.js';
import { adminNavBar } from './festa-tally.js';

const GROUPS = [
  { key: 'grand', name: '최우수상', icon: '🏆', certHint: '행정안전부 장관상', prizeHint: '50만원 상당', count: 1 },
  { key: 'excellence', name: '우수상', icon: '🥈', certHint: '행정안전부 장관상', prizeHint: '30만원 상당', count: 2 },
  { key: 'encouragement', name: '장려상', icon: '🎖️', certHint: '한국서부발전 사장상', prizeHint: '30만원 상당', count: 3 },
];
// 발표 순서: 장려상(3) → 우수상(2) → 최우수상(1)
const CEREMONY_GROUPS = [GROUPS[2], GROUPS[1], GROUPS[0]];
const STAGES = ['encouragement', 'excellence', 'grand'];
const ORDINAL = ['①', '②', '③'];

function awardPaths(runId) {
  const rehearsal = runId !== undefined;
  const scope = rehearsal ? `/festa/rehearsal/${encodeURIComponent(runId)}` : '/festa';
  return {
    rehearsal, api: `${scope}/awards`, results: `#${scope}/results`, list: `#${scope}/awards`,
    manage: rehearsal ? '#/admin/festa/rehearsal' : '#/admin/festa/jury',
  };
}

async function api(paths, suffix = '', body) {
  const base = String(store?.base || CONFIG.r2?.apiBase || '/api').replace(/\/$/, '');
  const response = await fetch(`${base}${paths.api}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || '수상 정보를 불러오지 못했습니다.');
    error.status = response.status; throw error;
  }
  return result;
}

function card(row) {
  return `<article class="festa-awards-card festa-awards-card--${attr(row.award)}" data-testid="awards-recipient" data-award="${attr(row.award)}">
    <p class="festa-awards-certificate">${esc(row.certificate)}</p>
    <h3 class="festa-awards-name">${esc(row.name)}</h3><p class="festa-awards-institution">${esc(row.institution)}</p>
    <p class="festa-awards-project">${esc(row.projectTitle)}</p><p class="festa-awards-prize">${esc(row.prizeText)}</p>
  </article>`;
}

function allRecipients(publication) {
  return GROUPS.map((group) => `<section class="festa-awards-group" aria-labelledby="award-${group.key}">
    <h2 id="award-${group.key}" class="festa-awards-group-title">${group.name}</h2>
    <div class="festa-awards-grid festa-awards-grid--${group.key}">${publication.recipients.filter((row) => row.award === group.key).map(card).join('')}</div>
  </section>`).join('');
}

/* ------------------------------------------- 폭죽 · 컨페티 애니메이션 -- */

function startFireworks(canvas, awardKey = 'encouragement') {
  if (!canvas || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return { burst() {}, stop() {} };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return { burst() {}, stop() {} };

  const palettes = {
    grand: ['#ffd76a', '#fff0b3', '#ff7aa8', '#ffb347', '#ffffff', '#6ef3c5'],
    excellence: ['#ffe082', '#9be7ff', '#ff80ab', '#a5f3c8', '#ffffff', '#ffd180'],
    encouragement: ['#ffd57e', '#7ee8c0', '#ff9ab5', '#8cd3ff', '#f7e4a6', '#ffffff'],
  };
  const colors = palettes[awardKey] || palettes.encouragement;

  let width = 0;
  let height = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const sparks = [];
  const confetti = [];
  let running = true;
  let rafId = 0;
  let intervalId = 0;

  const spawnBurst = (cx, cy, count = 46) => {
    const baseHue = colors[Math.floor(Math.random() * colors.length)];
    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.18;
      const speed = 2.4 + Math.random() * (awardKey === 'grand' ? 6.6 : 5.4);
      sparks.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.7,
        size: 2.1 + Math.random() * 2.6,
        color: Math.random() < 0.45 ? baseHue : colors[Math.floor(Math.random() * colors.length)],
        alpha: 1,
        decay: 0.011 + Math.random() * 0.011,
        trail: [],
      });
    }
    for (let i = 0; i < 14; i += 1) {
      confetti.push({
        x: Math.random() * width,
        y: -12 - Math.random() * 60,
        vx: (Math.random() - 0.5) * 2.2,
        vy: 1.6 + Math.random() * 2.6,
        w: 7 + Math.random() * 6,
        h: 4 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.16,
        color: colors[Math.floor(Math.random() * colors.length)],
        alpha: 0.95,
      });
    }
  };

  const launchVolley = () => {
    if (!running || !canvas.isConnected) return;
    const bursts = awardKey === 'grand' ? 4 : awardKey === 'excellence' ? 3 : 2;
    for (let b = 0; b < bursts; b += 1) {
      const delay = b * 220;
      setTimeout(() => {
        if (!running || !canvas.isConnected) return;
        const x = width * (0.14 + Math.random() * 0.72);
        const y = height * (0.12 + Math.random() * 0.42);
        spawnBurst(x, y, awardKey === 'grand' ? 60 : 44);
      }, delay);
    }
  };

  const tick = () => {
    if (!running || !canvas.isConnected) {
      stop();
      return;
    }
    ctx.clearRect(0, 0, width, height);

    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const p = sparks[i];
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 5) p.trail.shift();
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.975;
      p.vy = p.vy * 0.975 + 0.085;
      p.alpha -= p.decay;
      if (p.alpha <= 0.02) { sparks.splice(i, 1); continue; }

      for (let t = 0; t < p.trail.length; t += 1) {
        const pt = p.trail[t];
        ctx.globalAlpha = p.alpha * ((t + 1) / (p.trail.length + 1)) * 0.45;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, p.size * 0.65, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = confetti.length - 1; i >= 0; i -= 1) {
      const c = confetti[i];
      c.x += c.vx + Math.sin(c.rot) * 0.5;
      c.y += c.vy;
      c.rot += c.vrot;
      if (c.y > height + 30) { confetti.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = c.alpha;
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(tick);
  };

  const stop = () => {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (intervalId) clearInterval(intervalId);
    window.removeEventListener('resize', resize);
  };

  launchVolley();
  intervalId = setInterval(launchVolley, awardKey === 'grand' ? 1400 : 1800);
  rafId = requestAnimationFrame(tick);

  return {
    burst: launchVolley,
    stop,
  };
}

function congratsMessage(row) {
  return `${row.awardName}(${row.certificate} · 상품 ${row.prizeText}) 수상을 진심으로 축하합니다!`;
}

export async function festaAwardsView(mount, { runId } = {}) {
  const paths = awardPaths(runId);
  const pagePath = currentPath();
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;
  let publication;
  try { publication = await api(paths); }
  catch (error) {
    if (pagePath !== currentPath()) return;
    mount.innerHTML = `<section class="section"><div class="wrap" data-testid="awards-unpublished">${emptyState({
      title: error.status === 404 ? '수상 결과 발표를 기다려 주세요' : '발표 자료를 불러오지 못했습니다',
      body: error.status === 404 ? (paths.rehearsal ? '관리자가 테스트 본선을 마감하고 수상 순서를 확정하면 연습 발표가 열립니다.' : '2차 심사 마감과 수상 순서 확정 후 발표가 열립니다.') : error.message,
      action: '<button class="btn btn--primary" data-testid="awards-retry">발표 상태 다시 확인</button> <a class="btn btn--outline" href="#/">홈으로 돌아가기</a>',
    })}</div></section>`;
    mount.querySelector('[data-testid="awards-retry"]').addEventListener('click', () => festaAwardsView(mount, { runId }));
    return;
  }
  if (pagePath !== currentPath()) return;

  const presentation = currentPath().endsWith('/results') || currentQuery().get('mode') === 'present';
  // 발표 순서: 장려상 3명 (0,1,2) → 우수상 2명 (3,4) → 최우수상 1명 (5)
  const sequence = STAGES.flatMap((award) => publication.recipients.filter((row) => row.award === award));
  const revealedSet = new Set();
  let activeIndex = -1; // 현재 전체화면 팝업으로 열려 있는 인덱스 (-1이면 닫힘)
  let checking = false;
  let activeFireworks = null;

  const stopFireworks = () => {
    activeFireworks?.stop();
    activeFireworks = null;
  };

  const onKeyDown = (event) => {
    if (pagePath !== currentPath()) {
      stopFireworks();
      document.removeEventListener('keydown', onKeyDown);
      return;
    }
    if (activeIndex >= 0 && event.key === 'Escape') {
      event.preventDefault();
      closePopup();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  const closePopup = () => {
    const prevIdx = activeIndex;
    stopFireworks();
    activeIndex = -1;
    render();
    if (prevIdx >= 0) {
      mount.querySelector(`[data-slot-index="${prevIdx}"]`)?.focus({ preventScroll: true });
    }
  };

  const openSlot = async (index) => {
    if (checking || index < 0 || index >= sequence.length) return;
    if (paths.rehearsal) {
      // 다른 창에서 연습 회차를 초기화했다면 예전 발표 자료로 수상자를 공개하지 않습니다.
      checking = true;
      try { await api(paths); }
      catch {
        stopFireworks();
        document.removeEventListener('keydown', onKeyDown);
        if (pagePath === currentPath()) await festaAwardsView(mount, { runId });
        return;
      } finally { checking = false; }
      if (pagePath !== currentPath()) return;
    }
    revealedSet.add(index);
    activeIndex = index;
    render();
  };

  const nextUnrevealedIndex = (after = -1) => {
    for (let i = after + 1; i < sequence.length; i += 1) {
      if (!revealedSet.has(i)) return i;
    }
    for (let i = 0; i < sequence.length; i += 1) {
      if (!revealedSet.has(i)) return i;
    }
    return -1;
  };

  const renderPopupHtml = (index) => {
    const row = sequence[index];
    if (!row) return '';
    const group = GROUPS.find((g) => g.key === row.award) || GROUPS[2];
    const nextIdx = nextUnrevealedIndex(index);
    const nextRow = nextIdx >= 0 ? sequence[nextIdx] : null;
    const nextGroup = nextRow ? GROUPS.find((g) => g.key === nextRow.award) : null;
    const nextLabel = nextGroup ? `다음 발표 (${nextGroup.name}) →` : '';
    return `<div class="festa-award-popup festa-award-popup--${attr(row.award)}" role="dialog" aria-modal="true" aria-labelledby="festaPopupAwardTitle" data-testid="awards-popup" data-award="${attr(row.award)}">
      <canvas class="festa-fireworks-canvas" data-fireworks-canvas aria-hidden="true"></canvas>
      <div class="festa-award-popup__inner">
        <div class="festa-award-popup__card festa-awards-card festa-awards-card--${attr(row.award)}" data-testid="awards-recipient" data-award="${attr(row.award)}">
          <div class="festa-award-popup__emblem" aria-hidden="true">${group.icon}</div>
          <h2 id="festaPopupAwardTitle" class="festa-award-popup__tier">${esc(row.awardName)}</h2>
          <p class="festa-awards-certificate">${esc(row.certificate)}</p>
          <p class="festa-awards-institution">${esc(row.institution)}</p>
          <p class="festa-awards-name">${esc(row.name)}</p>
          <p class="festa-awards-project">${esc(row.projectTitle)}</p>
          <p class="festa-awards-prize">상품 · ${esc(row.prizeText)}</p>
          <p class="festa-award-popup__congrats" data-testid="awards-congrats">${esc(congratsMessage(row))}</p>
        </div>
        <div class="festa-award-popup__actions">
          <button type="button" class="btn btn--outline" data-testid="awards-fireworks-burst">🎆 폭죽 다시 터뜨리기</button>
          ${nextIdx >= 0 ? `<button type="button" class="btn btn--primary" data-testid="awards-popup-next" data-open-next="${nextIdx}">${esc(nextLabel)}</button>` : ''}
          <button type="button" class="btn ${nextIdx >= 0 ? 'btn--quiet' : 'btn--primary'}" data-testid="awards-popup-close">팝업 닫기</button>
        </div>
      </div>
    </div>`;
  };

  const renderBoardHtml = () => {
    const suggestedNext = nextUnrevealedIndex(-1);
    const allDone = revealedSet.size >= sequence.length;
    let cursor = 0;

    const sectionsHtml = CEREMONY_GROUPS.map((group) => {
      const items = sequence
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => row.award === group.key);
      const cardsHtml = items.map(({ row, idx }, localIdx) => {
        const isRevealed = revealedSet.has(idx);
        const isNext = idx === suggestedNext;
        const slotTitle = items.length > 1 ? `${group.name} ${ORDINAL[localIdx] || localIdx + 1}` : group.name;
        cursor += 1;
        if (isRevealed) {
          return `<button type="button" class="festa-slot festa-slot--${attr(group.key)} is-revealed" data-testid="award-slot" data-award="${attr(group.key)}" data-slot-index="${idx}" data-revealed="true">
            <span class="festa-slot__badge">${group.icon} ${esc(slotTitle)} · 발표 완료</span>
            <strong class="festa-slot__name">${esc(row.name)}</strong>
            <span class="festa-slot__inst">${esc(row.institution)}</span>
            <span class="festa-slot__project">${esc(row.projectTitle)}</span>
            <span class="festa-slot__meta">${esc(row.certificate)} · ${esc(row.prizeText)}</span>
          </button>`;
        }
        return `<button type="button" class="festa-slot festa-slot--${attr(group.key)} is-sealed${isNext ? ' is-next' : ''}" data-testid="award-slot" data-award="${attr(group.key)}" data-slot-index="${idx}" data-revealed="false">
          <span class="festa-slot__seal" aria-hidden="true">${group.icon}</span>
          <strong class="festa-slot__title">${esc(slotTitle)}</strong>
          <span class="festa-slot__hint">${isNext ? '✨ 클릭하여 발표하기' : '클릭하여 발표하기'}</span>
          <span class="festa-slot__meta">${esc(group.certHint)} · ${esc(group.prizeHint)}</span>
        </button>`;
      }).join('');

      return `<section class="festa-ceremony-tier festa-ceremony-tier--${attr(group.key)}" aria-labelledby="tier-${group.key}">
        <div class="festa-ceremony-tier__head">
          <h2 id="tier-${group.key}">${group.icon} ${esc(group.name)} <span class="festa-ceremony-tier__count">(${items.length}명)</span></h2>
          <p class="festa-ceremony-tier__sub">${esc(group.certHint)} · 상품 ${esc(group.prizeHint)}</p>
        </div>
        <div class="festa-slot-grid festa-slot-grid--${attr(group.key)}">${cardsHtml}</div>
      </section>`;
    }).join('');

    return `<section class="festa-awards-stage" data-testid="awards-stage" aria-label="수상작 발표 보드">
      <div class="festa-ceremony-progress" data-testid="awards-progress">
        <span>장려상(3) → 우수상(2) → 최우수상(1) 순서로 카드를 클릭해 발표하세요</span>
        <strong>${revealedSet.size} / ${sequence.length} 발표</strong>
      </div>
      ${allDone ? `<div class="festa-ceremony-complete-banner" data-testid="awards-ending">🎉 모든 수상자 발표가 완료되었습니다! 수상을 진심으로 축하합니다!</div>` : ''}
      <div class="festa-ceremony-board" data-testid="awards-board" data-cursor="${cursor}">
        ${sectionsHtml}
      </div>
    </section>`;
  };

  const render = () => {
    stopFireworks();
    if (pagePath !== currentPath()) {
      document.removeEventListener('keydown', onKeyDown);
      return;
    }
    const activeRow = activeIndex >= 0 ? sequence[activeIndex] : null;
    const awardAttr = activeRow?.award || (revealedSet.size >= sequence.length ? 'ending' : 'intro');

    mount.innerHTML = `<div class="festa-awards ${presentation ? 'festa-awards--presentation' : ''}" data-testid="awards-public" data-award="${attr(awardAttr)}" data-revealed-count="${revealedSet.size}">
      <header class="festa-awards-heading">
        <p class="festa-awards-eyebrow">${paths.rehearsal ? 'AI Build Camp 테스트 · ' : ''}${esc(publication.title)}</p>
        <div class="festa-awards-mark" aria-hidden="true">✦</div>
        <h1>${presentation ? '수상작 발표' : '최종 수상 결과'}</h1>
        <p>${presentation ? '장려상부터 하나씩 클릭하여 전체화면 폭죽과 함께 수상자를 발표하세요.' : '수상하신 모든 분께 축하의 말씀을 전합니다.'}</p>
      </header>
      <nav class="festa-awards-controls" aria-label="수상 결과 보기 방식">
        ${presentation
          ? `<a class="btn btn--outline" data-testid="awards-all-link" href="${attr(paths.list)}">전체 수상자 보기</a>
             <button type="button" class="btn btn--quiet" data-testid="awards-restart">처음부터 다시 가리기</button>`
          : `<a class="btn btn--primary" data-testid="awards-present" href="${attr(paths.results)}">🎆 수상작 발표 시작</a>`}
        <a class="btn btn--quiet" href="#/">홈으로</a>
      </nav>
      ${presentation ? renderBoardHtml() : `<div class="festa-awards-all" data-testid="awards-all">${allRecipients(publication)}</div>`}
      <p class="festa-awards-footer">말하는 대로, 바이브 코딩 페스타</p>
      ${presentation && activeIndex >= 0 ? renderPopupHtml(activeIndex) : ''}
    </div>`;

    if (!presentation) return;

    mount.querySelectorAll('[data-slot-index]').forEach((btn) => btn.addEventListener('click', () => {
      openSlot(Number(btn.dataset.slotIndex));
    }));

    mount.querySelector('[data-testid="awards-restart"]')?.addEventListener('click', () => {
      stopFireworks();
      revealedSet.clear();
      activeIndex = -1;
      render();
    });

    if (activeIndex >= 0) {
      const canvas = mount.querySelector('[data-fireworks-canvas]');
      activeFireworks = startFireworks(canvas, activeRow?.award || 'encouragement');
      mount.querySelector('[data-testid="awards-fireworks-burst"]')?.addEventListener('click', () => {
        activeFireworks?.burst();
      });
      mount.querySelector('[data-testid="awards-popup-next"]')?.addEventListener('click', (event) => {
        openSlot(Number(event.currentTarget.dataset.openNext));
      });
      mount.querySelector('[data-testid="awards-popup-close"]')?.addEventListener('click', closePopup);
      mount.querySelector('[data-testid="awards-popup"]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closePopup();
      });
      mount.querySelector('[data-testid="awards-popup-close"]')?.focus({ preventScroll: true });
    }
  };

  render();
}

export async function festaAwardsAdminView(mount, { runId } = {}) {
  const paths = awardPaths(runId);
  if (!currentUser() || !isAdmin()) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({ title: '관리자만 이용할 수 있습니다', body: '최종 시상 검토는 관리자 전용입니다.' })}</div></section>`;
    return;
  }
  let plan;
  const shell = () => {
    mount.innerHTML = `<section class="band festa-hero"><div class="wrap"><p class="crumb"><a href="#/admin/festa" style="color:inherit">접수 현황</a><span>/</span>최종 시상</p>
      <h1>${paths.rehearsal ? 'AI Build Camp 테스트 수상 결과' : '수상작 확정 · 발표'}</h1><p style="margin-top:var(--space-3)">${paths.rehearsal ? '이 회차의 예시 점수와 회원 평가로 테스트 수상 결과를 확인합니다.' : '최종 심사와 기관별 수상 조건을 확인한 뒤 장려상부터 하나씩 클릭하여 발표할 수 있습니다.'}</p>${paths.rehearsal ? '' : adminNavBar('awards')}</div></section>
      <section class="section"><div class="wrap festa-stack" data-testid="awards-admin-root">${spinner()}</div></section>`;
  };
  const render = (root, message = '') => {
    if (!root.isConnected) return;
    root.innerHTML = `<div class="row">${paths.rehearsal ? `<a class="btn btn--outline" href="#/admin/festa">접수 현황</a><a class="btn btn--outline" href="${attr(paths.manage)}">테스트 회차 관리</a>` : ''}<button class="btn btn--primary" type="button" data-testid="awards-pdf-download" ${plan.ranking?.length ? '' : 'disabled'}>📄 최종 심사 결과 PDF 다운로드</button><button class="btn btn--quiet" data-testid="awards-refresh">다시 검토</button></div>
      ${plan.published ? `<p class="notice notice--info">${paths.rehearsal ? '테스트 회차 수상 결과를 확정했습니다.' : '수상 결과를 공개했습니다. 아래 [수상작 발표 시작] 버튼을 누르면 장려상(3)·우수상(2)·최우수상(1)을 하나씩 클릭해 폭죽과 함께 전체화면으로 발표할 수 있습니다.'}</p><div class="row"><a class="btn btn--festa" href="${attr(paths.results)}" data-testid="awards-present-link">🎆 수상작 발표 시작</a><a class="btn btn--outline" href="${attr(paths.list)}" data-testid="awards-public-link">전체 수상자 보기</a></div>` : ''}
      <section class="card"><h2 class="page-title" style="font-size:2.2rem">선정 기준</h2>
        <p>행정안전부 상위 2명과 한국서부발전 상위 1명을 선정하고, 이 세 명의 최종 심사 평균 순으로 최우수상 1명과 우수상 2명을 결정합니다. 나머지 세 명은 장려상입니다.</p>
        <p class="field__hint" style="margin-top:var(--space-2)">장려상 3명(한국서부발전 사장상 · 30만원 상당) · 우수상 2명(행정안전부 장관상 · 30만원 상당) · 최우수상 1명(행정안전부 장관상 · 50만원 상당)</p>
        <p class="field__hint" style="margin-top:var(--space-2)">${esc(plan.tieRule)}</p></section>
      ${plan.issues.length ? `<section class="notice notice--warn" data-testid="awards-issues"><div><strong>공개 전에 확인해 주세요</strong><ul style="padding-left:2rem;list-style:disc">${plan.issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul></div></section>` : '<p class="notice notice--info" data-testid="awards-ready">최종 심사가 완료되어 수상 결과를 공개할 수 있습니다.</p>'}
      <section class="card"><h2 class="page-title" style="font-size:2.2rem">최종 심사 검토 · 관리자 전용</h2><p class="field__hint">아래 평균과 심사 완료 수는 공개 발표 화면에 표시되지 않습니다.</p>
        <div class="table-wrap" style="margin-top:var(--space-3)"><table class="table" data-testid="awards-ranking"><thead><tr><th>기관</th><th>성명 · 작품</th><th>최종 평균</th><th>문항별 평균</th><th>심사 완료</th></tr></thead><tbody>
          ${plan.ranking.map((row) => `<tr><td>${esc(row.institution)}</td><td><strong>${esc(row.name)}</strong><br>${esc(row.projectTitle)}</td><td>${row.average === null ? '—' : esc(row.average)}</td><td>${row.criterionAverages ? row.criterionAverages.map(esc).join(' / ') : '—'}</td><td>${esc(row.ballotCount)}건</td></tr>`).join('')}
        </tbody></table></div></section>
      ${plan.ties.length ? `<section class="card"><h2 class="page-title" style="font-size:2.2rem">완전동점 순서 확인</h2><p>총점과 네 문항 평균이 모두 같은 경우에만 적용됩니다. 점수가 다른 후보의 순위는 바뀌지 않습니다.</p>
        <ul class="field__hint" style="margin-block:var(--space-3)">${plan.ties.map((tie) => `<li>${esc(tie.reason)}: ${tie.entryIds.map((id) => esc(plan.ranking.find((row) => row.entryId === id)?.name || '')).join(' · ')}</li>`).join('')}</ul>
        <form data-testid="awards-tie-form"><div class="festa-form-grid">${Array.from({ length: 6 }, (_, index) => `<label class="field"><span class="field__label">동점 우선순위 ${index + 1}</span><select class="input" name="order${index}" required><option value="">후보 선택</option>${plan.ranking.map((row) => `<option value="${attr(row.entryId)}" ${plan.tieOrder[index] === row.entryId ? 'selected' : ''}>${esc(row.institution)} · ${esc(row.name)} · ${esc(row.projectTitle)}</option>`).join('')}</select></label>`).join('')}</div>
          <button type="submit" class="btn btn--outline" data-testid="awards-preview-order">이 순서로 다시 검토</button><p role="status" data-tie-status></p></form></section>` : ''}
      ${plan.ready ? `<section class="card" data-testid="awards-recipient-preview"><h2 class="page-title" style="font-size:2.2rem">공개 예정 수상자</h2><div class="festa-awards-preview-list">${plan.recipients.map((row) => `<article><span class="badge badge--gold">${esc(row.awardName)}</span><strong>${esc(row.institution)} · ${esc(row.name)}</strong><span>${esc(row.projectTitle)}</span><span>${esc(row.certificate)} · ${esc(row.prizeText)}</span></article>`).join('')}</div></section>` : ''}
      <div class="card"><p>${paths.rehearsal ? '확정하면 이 회차의 발표 주소에서 로그인한 회원이 테스트 수상자를 확인할 수 있습니다.' : '확정하여 공개하면 누구나 수상자의 기관·성명·작품명·상훈·상품을 확인할 수 있습니다. 점수와 심사위원 정보는 공개하지 않습니다.'}</p>
        <button class="btn btn--primary" style="margin-top:var(--space-3)" data-testid="awards-publish" ${!plan.ready || plan.published ? 'disabled' : ''}>수상 결과 확정·공개</button>
        <p role="status" aria-live="polite" data-testid="awards-admin-status" style="margin-top:var(--space-3)">${esc(message)}</p></div>`;
    root.querySelector('[data-testid="awards-refresh"]').addEventListener('click', load);
    root.querySelector('[data-testid="awards-pdf-download"]')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        const recipients = plan.publication?.recipients || plan.recipients || [];
        const awardMap = new Map(recipients.map((r) => [`${r.name}::${r.projectTitle}`, r.awardName]));
        const rows = (plan.ranking || []).map((row, idx) => ({
          rank: row.average !== null ? idx + 1 : null,
          institution: row.institution,
          title: row.projectTitle,
          authorName: row.name,
          scoreCount: row.ballotCount ?? 0,
          criterionAverages: row.criterionAverages,
          average: row.average,
          awardName: awardMap.get(`${row.name}::${row.projectTitle}`) || '',
        }));
        await downloadTallyResultPdf({
          kind: 'final',
          title: paths.rehearsal ? 'AI Build Camp 테스트 최종 심사 결과표' : '최종 심사 및 수상 결과표',
          statusLabel: plan.published ? '수상 확정·공개 완료' : (plan.ready ? '확정 대기' : '심사 진행·검토 중'),
          generatedAt: plan.publication?.publishedAt || new Date().toISOString(),
          summaryLine: `최종 후보 ${rows.length}명 · 총 평가 ${rows.reduce((s, r) => s + r.scoreCount, 0)}건`,
          rows,
          recipients,
          note: plan.tieRule || '',
        }, paths.rehearsal ? '테스트_최종심사결과' : '최종심사결과');
        toastOk('최종 심사 결과 PDF를 다운로드했습니다.');
      } catch (error) {
        toastErr(`PDF 생성 실패: ${error.message}`);
      } finally {
        btn.disabled = false;
      }
    });
    const tieForm = root.querySelector('[data-testid="awards-tie-form"]');
    tieForm?.addEventListener('input', () => {
      root.querySelector('[data-testid="awards-publish"]').disabled = true;
      tieForm.querySelector('[data-tie-status]').textContent = '변경한 순서로 다시 검토한 후 공개할 수 있습니다.';
    });
    tieForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!tieForm.reportValidity()) return;
      const tieOrder = Array.from({ length: 6 }, (_, index) => tieForm.elements[`order${index}`].value);
      if (new Set(tieOrder).size !== 6) { tieForm.querySelector('[data-tie-status]').textContent = '후보 6명을 한 번씩만 선택해 주세요.'; return; }
      try { plan = await api(paths, '/preview', { tieOrder }); render(root, '동점 순서를 반영한 결과입니다. 공개 예정 수상자를 확인해 주세요.'); }
      catch (error) { tieForm.querySelector('[data-tie-status]').textContent = error.message; }
    });
    root.querySelector('[data-testid="awards-publish"]').addEventListener('click', async () => {
      if (!plan.ready || plan.published) return;
      const confirmed = await confirmModal({
        title: '수상 결과를 확정하여 공개할까요?',
        body: paths.rehearsal ? '확정한 테스트 수상자 6명을 이 회차의 발표 화면에서 한 명씩 공개할 수 있습니다.' : '위에서 검토한 수상자 6명의 기관·성명·작품명·상훈·상품이 공개됩니다. 발표 자료는 확정 후 고정됩니다.',
        confirmLabel: '확정하고 공개',
      });
      if (!confirmed || !root.isConnected) return;
      const button = root.querySelector('[data-testid="awards-publish"]');
      button.disabled = true;
      try {
        plan.publication = await api(paths, '/publish', { revision: plan.revision, ...(plan.tieOrder.length ? { tieOrder: plan.tieOrder } : {}), confirm: true });
        plan.published = true; render(root, '수상 결과를 공개했습니다. 아래 [수상작 발표 시작] 버튼으로 발표를 진행할 수 있습니다.');
      } catch (error) {
        root.querySelector('[data-testid="awards-admin-status"]').textContent = error.message;
        button.disabled = false;
      }
    });
  };
  async function load() {
    shell();
    const root = mount.querySelector('[data-testid="awards-admin-root"]');
    try { plan = await api(paths, '/preview'); render(root); }
    catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err">${esc(error.message)}</p><a class="btn btn--outline" href="${attr(paths.manage)}">심사 설정으로 돌아가기</a>`; }
  }
  await load();
}
