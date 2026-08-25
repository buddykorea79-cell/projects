/** 강의자료 다운로드 — 공용 비밀번호로 잠금을 풀고 파일을 내려받습니다. */
import { store } from '../store/index.js';
import { CONFIG } from '../config.js';
import { esc, attr, fmtDate, fmtBytes, extOf } from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, fieldError, clearErrors, focusFirstError, busy,
} from '../ui.js';
import { isAdmin, materialsUnlocked, unlockMaterials, lockMaterials } from '../auth.js';

export async function materialsView(mount) {
  if (!materialsUnlocked()) { gateView(mount); return; }

  mount.innerHTML = `
    <section class="band" style="padding-block:var(--space-6)">
      <div class="wrap">
        <p class="crumb" style="color:var(--text-white-soft)">
          <a href="#/" style="color:#fff">홈</a><span>/</span>강의자료
        </p>
        <h1 style="font-size:3.2rem;color:#fff;font-weight:600">강의자료 다운로드</h1>
        <p style="color:var(--text-white-soft);margin-top:var(--space-2);font-size:1.6rem">
          수업에서 사용한 자료를 내려받을 수 있습니다.
        </p>
        <div class="row" style="margin-top:var(--space-4)">
          <a class="btn btn--onDark" href="#/">과제 제출하러 가기</a>
          ${isAdmin()
            ? '<a class="btn btn--ghostDark" href="#/admin/material/new">＋ 자료 등록</a>'
            : '<button class="btn btn--ghostDark" data-lock>열람 종료</button>'}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap wrap--mid">
        <div id="materialList">${spinner()}</div>
      </div>
    </section>`;

  const lock = mount.querySelector('[data-lock]');
  if (lock) {
    lock.addEventListener('click', () => {
      lockMaterials();
      toastOk('열람을 종료했습니다.');
      materialsView(mount);
    });
  }

  await renderList(mount.querySelector('#materialList'));
}

/* ----------------------------------------------------------------- 잠금 -- */

function gateView(mount) {
  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow" style="max-width:460px">
        <div style="text-align:center;margin-bottom:var(--space-5)">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" style="margin:0 auto var(--space-3)">
            <rect x="3" y="4" width="18" height="16" rx="2.5" fill="#006241"/>
            <path d="M8 9h8M8 12.5h8M8 16h5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
          <h1 class="page-title">강의자료 다운로드</h1>
          <p class="page-sub">수강생에게 안내된 비밀번호를 입력하세요.</p>
        </div>

        <form class="card" id="gateForm" novalidate>
          <label class="field">
            <span class="field__label">비밀번호</span>
            <input class="input" name="password" type="password" autocomplete="current-password"
                   placeholder="수업에서 안내한 비밀번호" />
            <span class="field__hint">한 번 입력하면 ${CONFIG.materialsSessionHours}시간 동안 유지됩니다.</span>
          </label>
          <button class="btn btn--primary btn--block btn--lg" type="submit">자료 보기</button>
        </form>

        <p style="text-align:center;margin-top:var(--space-4);font-size:1.3rem;color:var(--text-black-soft)">
          비밀번호를 모르시면 담당 강사에게 문의하세요.<br>
          관리자는 <a href="#/admin">로그인</a> 후 비밀번호 없이 열람할 수 있습니다.
        </p>
      </div>
    </section>`;

  const form = mount.querySelector('#gateForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '확인 중…');
    try {
      await unlockMaterials(form.password.value);
      toastOk('열람 권한이 확인되었습니다.');
      materialsView(mount);
    } catch (err) {
      busy(btn, false);
      fieldError(form.password, err.message);
      focusFirstError(form);
    }
  });
  form.password.focus();
}

/* ----------------------------------------------------------------- 목록 -- */

/** 파일 확장자에 맞는 배지 라벨. */
function fileBadge(name) {
  return (extOf(name) || 'FILE').toUpperCase().slice(0, 4);
}

async function renderList(mount) {
  try {
    const items = await store.listMaterials();
    if (!items.length) {
      mount.innerHTML = emptyState({
        title: '등록된 강의자료가 없습니다',
        body: '관리자가 자료를 올리면 이곳에 표시됩니다.',
        action: isAdmin()
          ? '<a class="btn btn--primary" href="#/admin/material/new">첫 자료 등록하기</a>'
          : '',
      });
      return;
    }

    mount.innerHTML = `<div class="stack-4">${items.map((m) => `
      <article class="card">
        <div class="page-head" style="margin-bottom:var(--space-2)">
          <div>
            <h2 style="font-size:1.9rem;color:var(--sb-green);font-weight:600">${esc(m.title)}</h2>
            <p class="page-sub">
              ${m.session ? `${esc(m.session)} · ` : ''}등록 ${esc(fmtDate(m.createdAt))}
            </p>
          </div>
          ${isAdmin() ? `<a class="btn btn--outline btn--sm" href="#/admin/material/${attr(m.id)}">편집</a>` : ''}
        </div>
        ${m.description ? `<div class="prose" style="font-size:1.5rem;color:var(--text-black-soft);margin-bottom:var(--space-3)">${esc(m.description)}</div>` : ''}
        <div class="filelist" data-files="${attr(m.id)}"></div>
      </article>`).join('')}</div>`;

    // 파일 URL 은 저장소에 따라 비동기로 만들어집니다.
    for (const m of items) {
      const holder = mount.querySelector(`[data-files="${CSS.escape(m.id)}"]`);
      if (!holder) continue;
      if (!(m.files || []).length) {
        holder.innerHTML = '<p style="color:var(--text-black-soft);font-size:1.4rem">첨부된 파일이 없습니다.</p>';
        continue;
      }
      const rows = [];
      for (const f of m.files) {
        const url = await store.fileURL(f);
        rows.push(`
          <div class="fileitem">
            <div class="fileitem__thumb">${esc(fileBadge(f.name))}</div>
            <div class="grow">
              <div class="fileitem__name">${esc(f.name)}</div>
              <div class="fileitem__meta">${esc(fmtBytes(f.size))}</div>
            </div>
            ${url
              ? `<a class="btn btn--primary btn--sm" href="${attr(url)}"
                   ${f.storage === 'github' ? 'target="_blank" rel="noopener"' : `download="${attr(f.name)}"`}>
                   내려받기</a>`
              : '<span class="badge badge--soft">파일 없음</span>'}
          </div>`);
      }
      holder.innerHTML = rows.join('');
    }
  } catch (e) {
    mount.innerHTML = `<div class="notice notice--err">강의자료를 불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}
