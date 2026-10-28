/**
 * 발표 순서 추첨 연출.
 *
 * 순서를 **정하는** 것은 저장소(R2 모드에서는 서버)가 이미 끝낸 일입니다.
 * 이 화면은 그 결과를 하나씩 열어 보여줄 뿐이라, 연출을 건너뛰거나 도중에
 * 닫아도 결과는 그대로입니다. 브라우저에서 섞으면 마음에 드는 결과가 나올
 * 때까지 다시 돌릴 수 있으므로 그렇게 하지 않습니다.
 *
 * 흐름
 *   ① 준비   — 뽑을 조들이 한자리에 모여 떨립니다
 *   ② 카운트 — 3 · 2 · 1
 *   ③ 추첨   — 1번 자리부터, 조 이름이 빠르게 돌다가 점점 느려지며 확정
 *   ④ 마무리 — 전체 순서가 한 번에 뜹니다
 *
 * 움직임을 줄이도록 설정한 사람(prefers-reduced-motion)과 `건너뛰기`·ESC 는
 * ③④ 를 건너뛰고 결과만 봅니다.
 */
import { esc, attr } from '../utils.js';
import { teamLabel } from '../camp.js';

/** 자리 하나를 뽑는 데 쓰는 시간. 뒤로 갈수록 조금씩 길어집니다. */
const SPIN_MS = (i) => Math.min(1500 + i * 180, 2600);
/** 이름이 바뀌는 간격 — 처음엔 눈으로 못 쫓을 만큼 빠르다가 뚝뚝 끊깁니다. */
const TICK_MIN = 55;
const TICK_MAX = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 움직임을 줄여달라고 해 둔 브라우저인지. */
function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

/**
 * 추첨 연출을 띄웁니다. 연출이 끝나거나 닫히면 resolve 합니다.
 *
 * @param {Array<{seat:number, sub:object}>} rows  1번부터 늘어놓은 결과
 * @param {{seq?:number, replay?:boolean}} opts
 */
export function playDraw(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => r?.sub) : [];
  if (!list.length) return Promise.resolve();

  const seq = Math.max(1, Math.round(Number(opts.seq)) || 1);
  const root = document.createElement('div');
  root.className = 'drawstage';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '발표 순서 추첨');

  root.innerHTML = `
    <button class="drawstage__skip" type="button" data-skip>건너뛰기</button>

    <div class="drawstage__inner">
      <p class="drawstage__kicker" data-kicker>
        ${seq > 1 ? `${esc(seq)}번째 추첨` : '발표 순서 추첨'}
      </p>

      <div class="drawstage__count" data-count hidden><span data-countv>3</span></div>

      <div class="drawstage__slot" data-slot hidden>
        <div class="drawstage__seat" data-seat>1번</div>
        <div class="drawstage__reel" data-reel aria-live="polite">—</div>
        <div class="drawstage__sub" data-sub>&nbsp;</div>
      </div>

      <ol class="drawstage__board" data-board></ol>

      <div class="drawstage__pool" data-pool aria-hidden="true">
        ${list.map((r) => `
          <span class="drawchip" data-chip="${attr(r.sub.id)}">${esc(teamLabel(r.sub.team))}</span>`).join('')}
      </div>

      <div class="drawstage__done" data-done hidden>
        <p class="drawstage__donetitle">발표 순서가 정해졌습니다</p>
        <button class="btn btn--onDark btn--lg" type="button" data-close>확인</button>
      </div>
    </div>`;

  document.body.appendChild(root);
  document.body.classList.add('is-drawing');

  const $ = (sel) => root.querySelector(sel);
  const countEl = $('[data-count]');
  const countV = $('[data-countv]');
  const slotEl = $('[data-slot]');
  const seatEl = $('[data-seat]');
  const reelEl = $('[data-reel]');
  const subEl = $('[data-sub]');
  const boardEl = $('[data-board]');
  const poolEl = $('[data-pool]');
  const doneEl = $('[data-done]');
  const kickerEl = $('[data-kicker]');

  let skipped = false;
  let finished = false;
  let resolveAll = () => {};
  const over = new Promise((r) => { resolveAll = r; });

  const close = () => {
    if (!root.isConnected) return;
    root.classList.add('is-leaving');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => {
      root.remove();
      document.body.classList.remove('is-drawing');
      resolveAll();
    }, 220);
  };

  function onKey(e) {
    if (e.key === 'Escape') { if (finished) close(); else skipped = true; }
  }
  document.addEventListener('keydown', onKey);
  $('[data-skip]').addEventListener('click', () => { if (finished) close(); else skipped = true; });
  $('[data-close]').addEventListener('click', close);
  // 결과를 다 보여준 뒤에는 바깥을 눌러도 닫힙니다.
  root.addEventListener('click', (e) => { if (finished && e.target === root) close(); });

  /** 확정된 한 줄을 결과판에 올립니다. */
  const pin = (row, { flash = true } = {}) => {
    const li = document.createElement('li');
    li.className = `drawrow${flash ? ' is-new' : ''}`;
    li.innerHTML = `
      <span class="drawrow__seat">${esc(row.seat)}</span>
      <span class="drawrow__team">${esc(teamLabel(row.sub.team))}</span>
      <span class="drawrow__title">${esc(row.sub.title)}</span>
      <span class="drawrow__who">${esc(row.sub.author?.name || '')}</span>`;
    boardEl.appendChild(li);
    const chip = poolEl.querySelector(`[data-chip="${CSS.escape(row.sub.id)}"]`);
    if (chip) chip.classList.add('is-taken');
  };

  /** 연출을 멈추고 전체 결과를 한 번에 보여줍니다. */
  const settle = () => {
    finished = true;
    countEl.hidden = true;
    slotEl.hidden = true;
    poolEl.hidden = true;
    kickerEl.textContent = seq > 1 ? `${seq}번째 추첨 결과` : '발표 순서';
    boardEl.innerHTML = '';
    for (const row of list) pin(row, { flash: false });
    doneEl.hidden = false;
    root.classList.add('is-done');
    $('[data-skip]').textContent = '닫기';
    $('[data-close]').focus();
  };

  (async () => {
    if (reducedMotion()) { settle(); return; }

    // ① 준비 — 뽑을 조들이 떨립니다
    poolEl.classList.add('is-shaking');
    await sleep(700);
    if (skipped) { settle(); return; }

    // ② 카운트다운
    countEl.hidden = false;
    for (const n of ['3', '2', '1']) {
      countV.textContent = n;
      countEl.classList.remove('is-beat');
      void countEl.offsetWidth;          // 애니메이션을 다시 돌리려고 한 번 끊어 줍니다
      countEl.classList.add('is-beat');
      await sleep(680);
      if (skipped) { settle(); return; }
    }
    countEl.hidden = true;

    // ③ 자리마다 한 번씩 — 이름이 돌다가 느려지며 멈춥니다
    slotEl.hidden = false;
    const pool = list.map((r) => r.sub);
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      seatEl.textContent = `${row.seat}번`;
      subEl.innerHTML = '&nbsp;';
      root.classList.add('is-spinning');

      // 아직 안 뽑힌 조들 사이를 돌립니다. pool 은 이미 확정 순서라 i 번째부터가
      // 남은 조들이고, 그래서 지나간 조가 다시 돌지 않습니다.
      const left = pool.slice(i);
      if (left.length > 1) {
        const span = SPIN_MS(i);
        const started = Date.now();
        let at = 0;
        while (Date.now() - started < span && !skipped) {
          at = (at + 1) % left.length;
          reelEl.textContent = teamLabel(left[at].team);
          const t = (Date.now() - started) / span;          // 0 → 1
          await sleep(TICK_MIN + (TICK_MAX - TICK_MIN) * t * t);
        }
      } else {
        // 마지막 한 자리는 돌릴 것이 없습니다 — 뜸을 들였다가 엽니다.
        reelEl.textContent = '…';
        await sleep(900);
      }
      if (skipped) { settle(); return; }

      // 확정 — 번쩍이고 결과판으로 내려갑니다
      root.classList.remove('is-spinning');
      reelEl.textContent = teamLabel(row.sub.team);
      subEl.textContent = row.sub.title;
      root.classList.add('is-hit');
      pin(row);

      await sleep(520);
      root.classList.remove('is-hit');
      if (skipped) { settle(); return; }
      await sleep(180);
    }

    settle();
  })();

  return over;
}

/* ------------------------------------------------- "한 번은 보여주기" -- */

const SEEN_KEY = (projectId) => `ah.camp.draw.${projectId}`;

/** 이 브라우저가 이미 본 추첨 회차. 못 읽으면 0 입니다. */
export function seenDraw(projectId) {
  try { return Number(localStorage.getItem(SEEN_KEY(projectId))) || 0; }
  catch { return 0; }
}

export function markDrawSeen(projectId, seq) {
  try { localStorage.setItem(SEEN_KEY(projectId), String(seq)); }
  catch { /* 사생활 보호 모드 */ }
}
