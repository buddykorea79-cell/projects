/** 공용 UI 조각 — 토스트, 모달, 라이트박스, 첨부 선택기, 렌더 헬퍼. */
import { esc, attr, fmtBytes, extOf, kindOf, $ } from './utils.js';
import { CONFIG } from './config.js';

/* -------------------------------------------------------------- toast -- */

export function toast(message, variant = '') {
  const root = $('#toaster');
  if (!root) return;
  // 화면을 덮지 않도록 가장 오래된 것부터 정리합니다.
  while (root.children.length >= 3) root.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast${variant ? ` toast--${variant}` : ''}`;
  el.setAttribute('role', variant === 'err' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, variant === 'err' ? 5200 : 3200);
}

export const toastOk  = (m) => toast(m, 'ok');
export const toastErr = (m) => toast(m, 'err');

/* -------------------------------------------------------------- modal -- */

/**
 * 확인 모달. 확인 시 true, 취소 시 false 로 resolve 됩니다.
 * @param {{title:string, body?:string, confirmLabel?:string, danger?:boolean,
 *          requireText?:string}} opts
 */
export function confirmModal(opts) {
  const {
    title, body = '', confirmLabel = '확인', cancelLabel = '취소',
    danger = false, requireText = '',
  } = opts;

  return new Promise((resolve) => {
    const root = $('#modalRoot');
    const prevFocus = document.activeElement;

    root.innerHTML = `
      <div class="modal-scrim" data-scrim>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mdTitle">
          <h2 id="mdTitle">${esc(title)}</h2>
          ${body ? `<p style="color:var(--text-black-soft);line-height:1.7">${esc(body)}</p>` : ''}
          ${requireText ? `
            <label class="field" style="margin-top:var(--space-3)">
              <span class="field__label">확인을 위해 <code>${esc(requireText)}</code> 를 입력하세요</span>
              <input class="input" data-require autocomplete="off" />
            </label>` : ''}
          <div class="modal__actions">
            <button class="btn btn--quiet" data-cancel>${esc(cancelLabel)}</button>
            <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok
              ${requireText ? 'aria-disabled="true"' : ''}>${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;

    const scrim = root.querySelector('[data-scrim]');
    const okBtn = root.querySelector('[data-ok]');
    const reqInput = root.querySelector('[data-require]');

    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      root.innerHTML = '';
      if (prevFocus?.focus) prevFocus.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Tab') trapFocus(e, root.querySelector('.modal'));
    };

    if (reqInput) {
      reqInput.addEventListener('input', () => {
        const match = reqInput.value.trim() === requireText;
        okBtn.setAttribute('aria-disabled', match ? 'false' : 'true');
      });
    }
    okBtn.addEventListener('click', () => {
      if (okBtn.getAttribute('aria-disabled') === 'true') return;
      close(true);
    });
    root.querySelector('[data-cancel]').addEventListener('click', () => close(false));
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(false); });
    document.addEventListener('keydown', onKey);

    (reqInput || okBtn).focus();
  });
}

function trapFocus(e, container) {
  if (!container) return;
  const focusables = container.querySelectorAll(
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* --------------------------------------------------------- lightbox -- */

export function lightbox(url, kind, name) {
  const root = $('#modalRoot');
  const media = kind === 'video'
    ? `<video src="${attr(url)}" controls autoplay playsinline></video>`
    : `<img src="${attr(url)}" alt="${attr(name || '')}" />`;
  root.innerHTML = `
    <div class="lightbox" data-scrim>
      <button class="lightbox__close" aria-label="닫기">&times;</button>
      ${media}
    </div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  root.querySelector('.lightbox__close').addEventListener('click', close);
  root.querySelector('[data-scrim]').addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-scrim')) close();
  });
  document.addEventListener('keydown', onKey);
  root.querySelector('.lightbox__close').focus();
}

/* --------------------------------------------------------- 첨부 선택기 -- */

/**
 * 드래그&드롭 + 파일선택 위젯. 선택된 File 객체 배열을 내부에 들고 있습니다.
 * 검증(확장자/크기/개수)은 여기서 끝냅니다.
 */
export class FilePicker {
  /**
   * @param {HTMLElement} mount
   * @param {{existing?: Array, maxFiles?: number, onRemoveExisting?: Function}} opts
   */
  constructor(mount, opts = {}) {
    this.mount = mount;
    this.files = [];
    this.existing = opts.existing || [];
    this.onRemoveExisting = opts.onRemoveExisting || null;
    this.maxFiles = opts.maxFiles ?? CONFIG.upload.maxFiles;
    this.render();
  }

  get total() { return this.files.length + this.existing.length; }

  render() {
    const { maxFileMB, allowedExt } = CONFIG.upload;
    this.mount.innerHTML = `
      <div class="drop" data-drop tabindex="0" role="button"
           aria-label="파일을 선택하거나 이곳에 끌어다 놓으세요">
        <svg class="drop__icon" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" stroke="currentColor" stroke-width="2"
                stroke-linecap="round"/>
        </svg>
        <div class="drop__title">파일을 끌어다 놓거나 클릭해 선택</div>
        <div class="drop__hint">
          이미지 · 동영상 · 문서 &nbsp;|&nbsp; 최대 ${this.maxFiles}개, 개당 ${maxFileMB}MB<br>
          ${esc(allowedExt.join(', '))}
        </div>
        <input type="file" multiple hidden data-input
               accept="${attr(allowedExt.map((e) => `.${e}`).join(','))}" />
      </div>
      <div class="filelist" data-list></div>`;

    const drop = this.mount.querySelector('[data-drop]');
    const input = this.mount.querySelector('[data-input]');

    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => { this.add(Array.from(input.files)); input.value = ''; });

    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
      e.preventDefault(); drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => {
      e.preventDefault(); drop.classList.remove('is-over');
    }));
    drop.addEventListener('drop', (e) => this.add(Array.from(e.dataTransfer?.files || [])));

    this.renderList();
  }

  add(incoming) {
    const { maxFileMB, allowedExt } = CONFIG.upload;
    const limit = maxFileMB * 1024 * 1024;

    for (const file of incoming) {
      if (this.total >= this.maxFiles) {
        toastErr(`첨부는 최대 ${this.maxFiles}개까지 가능합니다.`);
        break;
      }
      const ext = extOf(file.name);
      if (!allowedExt.includes(ext)) {
        toastErr(`허용되지 않는 형식입니다: ${file.name}`);
        continue;
      }
      if (file.size > limit) {
        toastErr(`${file.name} — ${maxFileMB}MB 를 초과합니다 (${fmtBytes(file.size)})`);
        continue;
      }
      if (this.files.some((f) => f.name === file.name && f.size === file.size)) continue;
      this.files.push(file);
    }
    this.renderList();
  }

  renderList() {
    const list = this.mount.querySelector('[data-list]');
    const rows = [];

    this.existing.forEach((f, i) => rows.push(this.row({
      name: f.name, size: f.size, kind: kindOf(f), badge: '기존', index: i, existing: true,
    })));
    this.files.forEach((f, i) => rows.push(this.row({
      name: f.name, size: f.size, kind: kindOf(f), badge: '신규', index: i, existing: false,
    })));

    list.innerHTML = rows.join('');

    list.querySelectorAll('[data-rm]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const i = Number(btn.dataset.index);
        if (btn.dataset.existing === 'true') {
          const ok = await confirmModal({
            title: '첨부를 삭제할까요?',
            body: `"${this.existing[i].name}" 을(를) 이 제출물에서 제거합니다.`,
            confirmLabel: '삭제', danger: true,
          });
          if (!ok) return;
          const removed = this.existing.splice(i, 1)[0];
          if (this.onRemoveExisting) this.onRemoveExisting(removed);
        } else {
          this.files.splice(i, 1);
        }
        this.renderList();
      });
    });
  }

  row({ name, size, kind, badge, index, existing }) {
    const icon = { image: 'IMG', video: 'VID', pdf: 'PDF', file: extOf(name).toUpperCase().slice(0, 4) || 'FILE' }[kind];
    return `
      <div class="fileitem">
        <div class="fileitem__thumb">${esc(icon)}</div>
        <div class="grow">
          <div class="fileitem__name">${esc(name)}</div>
          <div class="fileitem__meta">${esc(fmtBytes(size))} · <span class="badge badge--soft" style="padding:1px 8px;font-size:1.1rem">${esc(badge)}</span></div>
        </div>
        <button type="button" class="btn btn--quiet btn--sm" data-rm
                data-index="${index}" data-existing="${existing}" aria-label="${attr(name)} 제거">제거</button>
      </div>`;
  }
}

/* ---------------------------------------------------------- 렌더 헬퍼 -- */

export function spinner() { return '<div class="spinner" role="status" aria-label="불러오는 중"></div>'; }

export function emptyState({ title, body, action = '' }) {
  return `
    <div class="empty">
      <svg class="empty__icon" width="64" height="64" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="5" width="18" height="15" rx="2" stroke="currentColor" stroke-width="1.6"/>
        <path d="M3 9h18M8 13h8M8 16h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <h3>${esc(title)}</h3>
      <p>${esc(body)}</p>
      ${action ? `<div style="margin-top:var(--space-4)">${action}</div>` : ''}
    </div>`;
}

export function fieldError(input, message) {
  input.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');
  const holder = input.closest('.field') || input.parentElement;
  let err = holder.querySelector('.field__err');
  if (!err) {
    err = document.createElement('span');
    err.className = 'field__err';
    holder.appendChild(err);
  }
  err.textContent = message;
}

export function clearErrors(form) {
  form.querySelectorAll('.is-invalid').forEach((el) => {
    el.classList.remove('is-invalid');
    el.removeAttribute('aria-invalid');
  });
  form.querySelectorAll('.field__err').forEach((el) => el.remove());
}

/** 첫 번째 오류 필드로 스크롤 + 포커스. */
export function focusFirstError(form) {
  const el = form.querySelector('.is-invalid');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus({ preventScroll: true });
}

/** 버튼을 진행중 상태로 잠갔다 푸는 헬퍼. */
export function busy(btn, on, labelWhenBusy = '처리 중…') {
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = labelWhenBusy;
    btn.setAttribute('aria-disabled', 'true');
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.removeAttribute('aria-disabled');
  }
}
