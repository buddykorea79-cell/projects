/** 강의자료 — 회원이면 목록을 보고 파일을 받을 수 있습니다. */
import { store } from '../store/index.js';
import { esc, attr, fmtDate, fmtBytes, extOf, downloadLink, linkify, firstUrl } from '../utils.js';
import { spinner, emptyState } from '../ui.js';
import { isAdmin } from '../auth.js';

export async function materialsView(mount) {
  mount.innerHTML = `
    <section class="band" style="padding-block:var(--space-6)">
      <div class="wrap">
        <p class="crumb" style="color:var(--text-white-soft)">
          <a href="#/" style="color:#fff">홈</a><span>/</span>강의자료
        </p>
        <h1 style="font-size:3.2rem;color:#fff;font-weight:600">강의자료</h1>
        <p style="color:var(--text-white-soft);margin-top:var(--space-2);font-size:1.6rem">
          수업에서 사용한 자료를 받을 수 있습니다.
        </p>
        <div class="row" style="margin-top:var(--space-4)">
          <a class="btn btn--onDark" href="#/">과제 제출하러 가기</a>
          ${isAdmin() ? '<a class="btn btn--ghostDark" href="#/admin/material/new">＋ 자료 등록</a>' : ''}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div id="materialList">${spinner()}</div>
      </div>
    </section>`;

  await renderList(mount.querySelector('#materialList'));
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

    // 한 행에 2칸. 카드 높이가 달라도 그리드가 알아서 맞춰 줍니다.
    mount.innerHTML = `<div class="grid">${items.map((m) => {
      const link = firstUrl(m.description);
      return `
      <article class="card material">
        <div class="page-head" style="margin-bottom:var(--space-2)">
          <div>
            <h2 style="font-size:1.9rem;color:var(--sb-green);font-weight:600">${esc(m.title)}</h2>
            <p class="page-sub">
              ${m.session ? `${esc(m.session)} · ` : ''}등록 ${esc(fmtDate(m.createdAt))}
            </p>
          </div>
          ${isAdmin() ? `<a class="btn btn--outline btn--sm" href="#/admin/material/${attr(m.id)}">편집</a>` : ''}
        </div>
        ${m.description ? `<div class="prose material__desc">${linkify(m.description)}</div>` : ''}
        ${link ? `
          <div class="row" style="margin-bottom:var(--space-3)">
            <a class="btn btn--outline btn--sm" href="${attr(link)}" target="_blank" rel="noopener noreferrer">
              바로가기
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-8.5 8.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
                <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
              <span class="sr-only">(새 창)</span>
            </a>
          </div>` : ''}
        <div class="filelist" data-files="${attr(m.id)}"></div>
      </article>`;
    }).join('')}</div>`;

    // 파일 URL 은 저장소에 따라 비동기로 만들어집니다.
    for (const m of items) {
      const holder = mount.querySelector(`[data-files="${CSS.escape(m.id)}"]`);
      if (!holder) continue;
      if (!(m.files || []).length) {
        // 링크만 있는 자료라면 위 "바로가기" 가 이미 행동을 안내하므로 조용히 둡니다.
        holder.innerHTML = firstUrl(m.description)
          ? ''
          : '<p style="color:var(--text-black-soft);font-size:1.4rem">첨부된 파일이 없습니다.</p>';
        continue;
      }
      const rows = [];
      for (const f of m.files) {
        const dl = downloadLink(await store.fileURL(f), f);
        rows.push(`
          <div class="fileitem">
            <div class="fileitem__thumb">${esc(fileBadge(f.name))}</div>
            <div class="grow">
              <div class="fileitem__name">${esc(f.name)}</div>
              <div class="fileitem__meta">${esc(fmtBytes(f.size))}</div>
            </div>
            ${dl
              ? `<a class="btn btn--primary btn--sm" href="${attr(dl.href)}" ${dl.attrs}>내려받기</a>`
              : '<span class="badge badge--soft">파일 없음</span>'}
          </div>`);
      }
      holder.innerHTML = rows.join('');
    }
  } catch (e) {
    mount.innerHTML = `<div class="notice notice--err">강의자료를 불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}
