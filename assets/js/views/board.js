/** 소통방 — 회원 글쓰기 · 댓글, 관리자 공지 고정. */
import { store } from '../store/index.js';
import { currentUser, isAdmin } from '../auth.js';
import { esc, attr, fmtDate, fmtRelative, linkify, debounce } from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, confirmModal,
  fieldError, clearErrors, focusFirstError, busy,
} from '../ui.js';
import { go } from '../router.js';

/** 내가 쓴 글·댓글인지. 서버도 같은 기준으로 한 번 더 확인합니다. */
const isMine = (entry) => {
  const me = currentUser();
  return Boolean(me && entry?.author?.email && entry.author.email === me.email);
};

const writer = (a) => `${a?.institution ? `${esc(a.institution)} · ` : ''}<strong>${esc(a?.name || '알 수 없음')}</strong>`;

/* ------------------------------------------------------------- 목록 -- */

export async function boardView(mount) {
  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--mid">
        <div class="page-head">
          <div>
            <h1 class="page-title">소통방</h1>
            <p class="page-sub">궁금한 점, 자료 요청, 후기 등 자유롭게 남겨주세요.</p>
          </div>
          <a class="btn btn--primary" href="#/board/new">＋ 글쓰기</a>
        </div>

        <div class="toolbar">
          <input class="input" id="q" type="search" placeholder="제목 · 내용 · 작성자 검색" />
        </div>

        <div id="postList">${spinner()}</div>
      </div>
    </section>`;

  const holder = mount.querySelector('#postList');
  const qEl = mount.querySelector('#q');
  let all = [];

  const draw = () => {
    const q = qEl.value.trim().toLowerCase();
    const rows = all.filter((p) => {
      if (!q) return true;
      return [p.title, p.body, p.author?.institution, p.author?.name]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });

    if (!rows.length) {
      holder.innerHTML = emptyState({
        title: all.length ? '검색 결과가 없습니다' : '아직 글이 없습니다',
        body: all.length ? '다른 검색어로 시도해 보세요.' : '첫 글을 남겨보세요.',
        action: all.length ? '' : '<a class="btn btn--primary" href="#/board/new">글쓰기</a>',
      });
      return;
    }

    holder.innerHTML = rows.map(postRow).join('');
  };

  try {
    all = await store.listPosts();
    draw();
    qEl.addEventListener('input', debounce(draw, 200));
  } catch (e) {
    holder.innerHTML = `<div class="notice notice--err">불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

/** 목록의 글 한 줄. 공지는 위쪽에 모여 나오고 배지가 붙습니다. */
function postRow(p) {
  const n = (p.comments || []).length;
  const preview = String(p.body || '').replace(/\s+/g, ' ').slice(0, 120);

  return `
    <a class="card post ${p.pinned ? 'post--pinned' : ''}" href="#/board/${attr(p.id)}">
      <div class="post__head">
        ${p.pinned ? '<span class="badge badge--gold">공지</span>' : ''}
        <h2 class="post__title">${esc(p.title)}</h2>
        ${n ? `<span class="post__count" aria-label="댓글 ${n}개">💬 ${n}</span>` : ''}
      </div>
      <p class="post__preview">${esc(preview)}${p.body.length > 120 ? '…' : ''}</p>
      <p class="post__meta">${writer(p.author)} · ${esc(fmtRelative(p.createdAt))}</p>
    </a>`;
}

/* ------------------------------------------------------------- 상세 -- */

export async function postView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap wrap--mid">${spinner()}</div></section>`;

  const post = await store.getPost(id);
  if (!post) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--mid">${emptyState({
      title: '글을 찾을 수 없습니다',
      body: '삭제되었거나 주소가 잘못되었습니다.',
      action: '<a class="btn btn--outline" href="#/board">소통방으로</a>',
    })}</div></section>`;
    return;
  }

  const mine = isMine(post);
  const admin = isAdmin();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--mid stack-4">
        <p class="crumb"><a href="#/board">소통방</a><span>/</span>글</p>

        <article class="card">
          <div class="page-head" style="margin-bottom:var(--space-2)">
            <div>
              ${post.pinned ? '<span class="badge badge--gold">공지</span>' : ''}
              <h1 class="page-title" style="margin-top:var(--space-1)">${esc(post.title)}</h1>
              <p class="page-sub">
                ${writer(post.author)} · ${esc(fmtDate(post.createdAt, true))}
                ${post.updatedAt && post.updatedAt !== post.createdAt
    ? ` · 수정 ${esc(fmtDate(post.updatedAt, true))}` : ''}
              </p>
            </div>
            <div class="row" style="white-space:nowrap">
              ${admin ? `<button class="btn btn--outline btn--sm" data-pin>${
    post.pinned ? '공지 해제' : '공지로 지정'}</button>` : ''}
              ${mine || admin ? `<a class="btn btn--outline btn--sm" href="#/board/${attr(post.id)}/edit">수정</a>
                <button class="btn btn--quiet btn--sm" data-del style="color:var(--red)">삭제</button>` : ''}
            </div>
          </div>

          <div class="prose">${linkify(post.body)}</div>
        </article>

        <div class="card" id="commentCard">
          <h2 class="page-title" style="font-size:1.8rem;margin-bottom:var(--space-3)">
            댓글 <span id="commentCount" style="font-weight:400;color:var(--text-black-soft)">${
  (post.comments || []).length}</span>
          </h2>

          <div id="commentList"></div>

          <form id="commentForm" novalidate style="margin-top:var(--space-4)">
            <label class="field">
              <span class="sr-only">댓글 내용</span>
              <textarea class="textarea" name="body" rows="3" maxlength="2000"
                        placeholder="댓글을 남겨주세요."></textarea>
            </label>
            <div class="row row--end">
              <button class="btn btn--primary" type="submit">댓글 등록</button>
            </div>
          </form>
        </div>
      </div>
    </section>`;

  let current = post;
  const listEl = mount.querySelector('#commentList');
  const countEl = mount.querySelector('#commentCount');

  const drawComments = () => {
    const rows = current.comments || [];
    countEl.textContent = rows.length;
    listEl.innerHTML = rows.length
      ? rows.map((c) => `
        <div class="comment">
          <div class="comment__head">
            <span>${writer(c.author)}</span>
            <span class="comment__time">${esc(fmtRelative(c.createdAt))}</span>
            ${isMine(c) || isAdmin()
    ? `<button class="btn btn--quiet btn--sm" data-cdel="${attr(c.id)}">삭제</button>` : ''}
          </div>
          <div class="prose comment__body">${linkify(c.body)}</div>
        </div>`).join('')
      : '<p style="color:var(--text-black-soft);font-size:1.4rem">첫 댓글을 남겨보세요.</p>';

    listEl.querySelectorAll('[data-cdel]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: '댓글을 삭제할까요?', confirmLabel: '삭제', danger: true,
        });
        if (!ok) return;
        try {
          current = await store.deleteComment(current.id, btn.dataset.cdel);
          drawComments();
          toastOk('삭제되었습니다.');
        } catch (e) { toastErr(e.message); }
      });
    });
  };
  drawComments();

  const form = mount.querySelector('#commentForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const text = form.body.value.trim();
    if (!text) { fieldError(form.body, '댓글 내용을 입력하세요.'); focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '등록 중…');
    try {
      current = await store.addComment(current.id, text);
      form.body.value = '';
      drawComments();
      toastOk('댓글을 남겼습니다.');
    } catch (err) {
      toastErr(`댓글을 남기지 못했습니다 — ${err.message}`);
    } finally {
      busy(btn, false);
    }
  });

  mount.querySelector('[data-pin]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, '처리 중…');
    try {
      current = await store.pinPost(current.id, !current.pinned);
      toastOk(current.pinned ? '공지로 지정했습니다.' : '공지를 해제했습니다.');
      // 같은 주소라 라우터가 다시 그리지 않으므로 이 화면만 새로 그립니다.
      await postView(mount, { id: current.id });
    } catch (err) {
      busy(btn, false);
      toastErr(err.message);
    }
  });

  mount.querySelector('[data-del]')?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: '글을 삭제할까요?',
      body: '댓글도 함께 사라집니다. 되돌릴 수 없습니다.',
      confirmLabel: '삭제', danger: true,
    });
    if (!ok) return;
    try {
      await store.deletePost(current.id);
      toastOk('삭제되었습니다.');
      go('/board');
    } catch (e) { toastErr(e.message); }
  });
}

/* ------------------------------------------------------------- 작성 -- */

export async function postFormView(mount, { id }) {
  const isNew = !id || id === 'new';
  const post = isNew ? null : await store.getPost(id);

  if (!isNew && !post) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">${emptyState({
      title: '글을 찾을 수 없습니다',
      action: '<a class="btn btn--outline" href="#/board">소통방으로</a>',
    })}</div></section>`;
    return;
  }
  if (post && !isMine(post) && !isAdmin()) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">본인 글만 수정할 수 있습니다.</div>
      <div style="margin-top:var(--space-4)"><a class="btn btn--outline" href="#/board">소통방으로</a></div>
    </div></section>`;
    return;
  }

  const me = currentUser();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb"><a href="#/board">소통방</a><span>/</span>${isNew ? '글쓰기' : '수정'}</p>
        <h1 class="page-title" style="margin-bottom:var(--space-4)">${isNew ? '글쓰기' : '글 수정'}</h1>

        ${isNew ? `
        <div class="card card--flat" style="margin-bottom:var(--space-3)">
          <div class="field__label" style="margin-bottom:2px">작성자</div>
          <div style="font-size:1.5rem">
            ${esc(me.institution || '—')} · <strong>${esc(me.name)}</strong>
          </div>
        </div>` : ''}

        <form class="card" id="postForm" novalidate>
          <label class="field">
            <span class="field__label">제목<span class="field__req">*</span></span>
            <input class="input" name="title" maxlength="150"
                   value="${attr(post?.title || '')}" placeholder="제목을 입력하세요" />
          </label>
          <label class="field">
            <span class="field__label">내용<span class="field__req">*</span></span>
            <textarea class="textarea" name="body" rows="10" maxlength="20000"
                      placeholder="내용을 입력하세요. 주소를 적으면 링크가 됩니다.">${esc(post?.body || '')}</textarea>
          </label>

          <div class="row row--between" style="margin-top:var(--space-4)">
            <a class="btn btn--quiet" href="#/board">← 취소</a>
            <button class="btn btn--primary btn--lg" type="submit">${isNew ? '등록하기' : '저장하기'}</button>
          </div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector('#postForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    if (!form.title.value.trim()) { fieldError(form.title, '제목을 입력하세요.'); ok = false; }
    if (!form.body.value.trim()) { fieldError(form.body, '내용을 입력하세요.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '저장 중…');
    try {
      const saved = await store.savePost({
        id: post?.id,
        title: form.title.value.trim(),
        body: form.body.value.trim(),
      });
      toastOk(isNew ? '글을 등록했습니다.' : '수정되었습니다.');
      go(`/board/${saved.id}`);
    } catch (err) {
      busy(btn, false);
      toastErr(`저장하지 못했습니다 — ${err.message}`);
    }
  });

  form.title.focus();
}
