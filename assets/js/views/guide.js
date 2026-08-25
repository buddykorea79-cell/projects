/** 이용안내 — 교육생 / 관리자 / 저장소 설정 FAQ. */
import { CONFIG, STORAGE_LABEL } from '../config.js';
import { currentMode } from '../store/index.js';
import { esc } from '../utils.js';

const FAQ = [
  {
    id: 'submit',
    q: '과제는 어떻게 제출하나요?',
    a: '홈에서 프로젝트를 고른 뒤 [과제 제출하기] 를 누릅니다. 1단계에서 기관명·성명·이메일을, '
     + '2단계에서 제목·설명·첨부파일을 입력하면 끝입니다. 제출이 끝나면 수정코드가 발급됩니다.',
  },
  {
    id: 'materials',
    q: '강의자료는 어떻게 받나요?',
    a: '상단 메뉴의 [강의자료] 를 누르고, 수업에서 안내받은 비밀번호를 한 번 입력하면 '
     + '목록이 열립니다. 이후 12시간 동안은 다시 묻지 않습니다. '
     + '비밀번호를 모르면 담당 강사에게 문의하세요.',
  },
  {
    id: 'code',
    q: '수정코드를 잃어버렸어요.',
    a: '같은 브라우저에서 제출했다면 [내 제출물] 화면의 "코드 자동 입력" 버튼으로 되찾을 수 있습니다. '
     + '그렇지 않다면 관리자에게 이메일 주소를 알려 확인을 요청하세요. 관리자는 모든 제출물을 조회할 수 있습니다.',
  },
  {
    id: 'edit',
    q: '제출한 내용을 고치거나 지울 수 있나요?',
    a: '[내 제출물] 에서 이메일과 수정코드로 인증하면 수정·삭제할 수 있습니다. '
     + '단, 프로젝트가 마감된 뒤에는 잠깁니다. 코드 하나로 같은 이메일의 모든 제출물이 열립니다.',
  },
  {
    id: 'files',
    q: '어떤 파일을 첨부할 수 있나요?',
    a: `이미지(jpg·png·gif·webp), 동영상(mp4·webm·mov), 문서(pdf·docx·pptx·xlsx·hwp) 등입니다. `
     + `제출 1건당 최대 ${CONFIG.upload.maxFiles}개, 파일 하나당 ${CONFIG.upload.maxFileMB}MB 까지 올릴 수 있습니다.`,
  },
  {
    id: 'privacy',
    q: '입력한 개인정보는 어떻게 다뤄지나요?',
    a: '기관명·성명·이메일은 과제 확인과 본인 인증에만 씁니다. 제출물을 공개로 설정한 프로젝트에서도 '
     + '이메일 주소는 본인과 관리자에게만 보입니다. 과정이 끝나면 관리자가 일괄 삭제할 수 있습니다.',
  },
];

export function guideView(mount) {
  const mode = currentMode();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--mid stack-5">

        <div>
          <h1 class="page-title">이용안내</h1>
          <p class="page-sub">제출 방법과 운영 설정을 한 곳에 모았습니다.</p>
        </div>

        <div class="card">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-2)">자주 묻는 질문</h2>
          <div id="faq">
            ${FAQ.map((item, i) => `
              <div class="expander" data-open="${i === 0}">
                <button class="expander__btn" type="button" aria-expanded="${i === 0}">
                  <span>${esc(item.q)}</span>
                  <svg class="expander__chev" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                </button>
                <div class="expander__body" style="height:${i === 0 ? 'auto' : '0'}">
                  <div class="expander__inner">${esc(item.a)}</div>
                </div>
              </div>`).join('')}
          </div>
        </div>

        <div class="card" id="admin">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">비밀번호 바꾸기</h2>
          <h3 style="font-size:1.6rem;margin-bottom:8px">강의자료 열람 비밀번호</h3>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-bottom:var(--space-3)">
            수강생이 함께 쓰는 공용 암호입니다. 콘솔에서
            <code>await hashMaterials('새-비밀번호')</code> 를 실행해 나온 해시를
            <code>config.js</code> 의 <code>materialsHash</code> 에 넣으세요.
            서버 쪽 다운로드 잠금(<code>MATERIALS_PASSWORD</code>)을 켜 두었다면
            <strong>같은 비밀번호</strong>로 맞춰야 합니다.
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px;margin-top:var(--space-4)">관리자 계정</h3>
          <p style="color:var(--text-black-soft);line-height:1.8">
            계정은 <code>assets/js/config.js</code> 안의 <code>admins</code> 배열에 하드코딩되어 있습니다.
            비밀번호는 원문이 아니라 SHA-256 해시로만 저장됩니다. 새 해시는 이 사이트 어느 화면에서든
            개발자도구 콘솔을 열고 아래 한 줄을 실행해 얻습니다.
          </p>
          <pre style="background:var(--house-green);color:#fff;padding:var(--space-3);border-radius:var(--radius-card);overflow:auto;font-size:1.4rem;margin-top:var(--space-3)"><code>await hashAdmin('my@email.com', '새-비밀번호')</code></pre>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-top:var(--space-3)">
            출력된 <code>hash</code> 값을 config.js 에 붙여넣고 커밋하면 끝입니다.
          </p>
          <div class="notice notice--warn" style="margin-top:var(--space-3)">
            <strong>알아두세요.</strong> 정적 사이트에는 인증을 검증할 서버가 없습니다. 이 로그인은
            관리 화면을 가리는 잠금이며, 해시는 누구나 내려받아 대입 공격을 시도할 수 있습니다.
            길고 추측 불가능한 비밀번호를 쓰세요. 실제 데이터 변경 권한은 아래 저장소 설정이 통제합니다.
          </div>
        </div>

        <div class="card" id="storage">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">저장소 설정</h2>
          <p style="color:var(--text-black-soft);margin-bottom:var(--space-3)">
            현재 모드: <strong>${esc(STORAGE_LABEL[mode])}</strong>
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">① Cloudflare R2 <span class="badge badge--gold" style="font-size:1.1rem">권장</span></h3>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-bottom:var(--space-4)">
            파일과 색인이 모두 R2 버킷에 저장됩니다. 브라우저는 R2 를 직접 만지지 않고
            같은 도메인의 <code>/api</code> 만 호출하며, 버킷 권한은 서버 바인딩으로만 존재합니다.
            그래서 교육생에게 나눠줄 토큰이 없고, 큰 파일도 그대로 올라갑니다.
            Cloudflare Pages 에 R2 버킷을 <code>BUCKET</code> 이름으로 바인딩하기만 하면 됩니다.
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">② GitHub 저장소</h3>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-bottom:var(--space-4)">
            레포의 <code>data/</code> 를 데이터베이스로, <code>uploads/</code> 를 파일함으로 씁니다.
            쓰기에 토큰이 필요하고, 교육생 제출까지 받으려면 <code>worker/</code> 의 프록시를
            함께 배포해야 합니다. 파일 크기 제약도 더 큽니다.
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">③ 브라우저 저장</h3>
          <p style="color:var(--text-black-soft);line-height:1.8">
            설정이 전혀 필요 없고 즉시 동작합니다. 대신 데이터가 <strong>그 브라우저에만</strong> 남습니다.
            화면을 확인할 때 쓰세요. 실제 제출을 받을 수는 없습니다.
          </p>
          <div class="notice notice--info" style="margin-top:var(--space-4)">
            자세한 배포 순서는 레포의 <code>docs/SETUP.md</code> 에 단계별로 적혀 있습니다.
          </div>
        </div>

      </div>
    </section>`;

  // 아코디언 — height 를 실측해 부드럽게 여닫습니다.
  mount.querySelectorAll('.expander').forEach((exp) => {
    const btn = exp.querySelector('.expander__btn');
    const body = exp.querySelector('.expander__body');
    const inner = exp.querySelector('.expander__inner');

    btn.addEventListener('click', () => {
      const open = exp.dataset.open === 'true';
      body.style.height = `${open ? inner.offsetHeight : 0}px`;
      requestAnimationFrame(() => {
        body.style.height = `${open ? 0 : inner.offsetHeight}px`;
        exp.dataset.open = String(!open);
        btn.setAttribute('aria-expanded', String(!open));
      });
    });

    body.addEventListener('transitionend', () => {
      if (exp.dataset.open === 'true') body.style.height = 'auto';
    });
  });
}
