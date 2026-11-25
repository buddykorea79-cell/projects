/** 관리자 전용 가상 작품 심사 연습. 운영 API/R2에는 접근하지 않습니다. */
import { currentUser, isAdmin } from '../auth.js';
import { FESTA_RUBRIC as RUBRIC, validFestaScores as validScores } from '../festa.js';
import { esc, attr } from '../utils.js';
import { confirmModal, emptyState, stat } from '../ui.js';

// 실제 접수·실제 인물과 무관한 설명용 예시입니다. 외부 서비스 주소는 만들지 않습니다.
const SAMPLES = [
  {
    id: 'sample-01', title: '민원 업무 길잡이', category: '민원 안내', team: '시민지원팀', mode: '웹앱 예시',
    problem: '담당 업무와 구비 서류를 찾으려고 여러 부서에 같은 문의를 반복하는 상황을 줄입니다.',
    description: '민원 키워드를 입력하면 관련 업무, 준비 서류와 방문 전 확인 사항을 한 화면에 보여주는 안내 도구입니다.',
    features: ['키워드별 업무 분류', '구비 서류 체크리스트', '자주 묻는 질문의 관련 항목 표시'],
    input: '전입신고를 하려는데 어떤 준비가 필요한가요?',
    output: '예시 안내 카드: 주소 변경 업무 → 준비 서류 확인 → 신청 방법 확인. 각 항목을 체크리스트로 정리합니다.',
    limit: '예시 민원 12종만 등록되어 있고, 안내 내용의 최신 여부를 확인할 담당자 검토 기능은 아직 없습니다.',
    expansion: '부서별 업무 목록과 검토일을 추가하면 다른 민원 안내에도 적용할 수 있습니다.',
  },
  {
    id: 'sample-02', title: '회의록에서 할 일 찾기', category: '업무 자동화', team: '기획지원팀', mode: '웹앱 예시',
    problem: '회의가 끝난 뒤 결정 사항과 후속 업무를 사람이 다시 정리해야 하는 시간을 줄입니다.',
    description: '붙여넣은 회의 메모를 안건, 결정 사항, 할 일, 담당, 기한으로 나누고 원문과 비교할 수 있게 합니다.',
    features: ['메모에서 할 일 후보 추출', '담당·기한 직접 수정', '확정한 업무를 CSV로 내려받기'],
    input: '안내문 초안은 홍보 담당이 금요일까지 작성하고 다음 회의에서 검토하기로 했습니다.',
    output: '할 일: 안내문 초안 작성 / 담당: 홍보 담당 / 기한: 금요일 / 후속 일정: 다음 회의 검토',
    limit: '“이번 주 안에”처럼 모호한 기한은 원문 그대로 표시하며, 외부 일정표와는 연결되지 않습니다.',
    expansion: '정례회의, 행사 준비회의, 부서 인수인계 회의에 같은 표를 활용할 수 있습니다.',
  },
  {
    id: 'sample-03', title: '보조사업 서류 빠짐 확인', category: '서류 검토', team: '사업지원팀', mode: '로컬 실행 예시',
    problem: '신청 서류의 누락을 뒤늦게 발견해 접수자에게 여러 번 보완을 요청하는 일을 줄입니다.',
    description: '사업 유형에 맞는 제출 목록과 선택한 파일 이름을 대조하여 누락 의심 항목을 알려주는 도구입니다.',
    features: ['사업 유형별 필수 서류 목록', '파일명 기반 제출 여부 대조', '보완 요청 문안 초안 생성'],
    input: '필수 목록: 신청서, 계획서, 예산서 / 선택 파일: 신청서.pdf, 계획서.pdf',
    output: '확인 필요: 예산서 1건. 보완 요청 초안에 누락 항목을 넣고 담당자가 최종 확인합니다.',
    limit: '파일 내용이나 서명을 읽지는 못하므로 이름만 맞고 내용이 다른 파일은 걸러내지 못합니다.',
    expansion: '채용 서류, 공모사업, 행사 참가 신청 등 제출 목록이 정해진 업무에 적용할 수 있습니다.',
  },
  {
    id: 'sample-04', title: '현장 점검 사진 보고서', category: '현장 업무', team: '시설관리팀', mode: '로컬 실행 예시',
    problem: '현장 사진을 문서에 하나씩 붙이고 위치와 설명을 다시 입력하는 반복 작업을 줄입니다.',
    description: '점검 사진에 장소·점검 항목·조치 메모를 붙여 정해진 양식의 보고서 미리보기를 만드는 도구입니다.',
    features: ['사진 순서 변경', '사진별 위치·메모 입력', '보고서 인쇄 및 PDF 저장'],
    input: '사진 3장 / 장소: 별관 출입구 / 점검 항목: 안내 표지 / 메모: 글자 일부 훼손',
    output: '점검 개요와 사진 3장을 순서대로 배치한 보고서. 각 사진 아래에 장소와 조치 메모가 표시됩니다.',
    limit: '여러 사람이 같은 보고서를 함께 편집할 수 없고, 매우 큰 사진은 먼저 줄여야 합니다.',
    expansion: '공사 현장, 행사장 준비, 공공시설 정기 점검의 공통 양식으로 확장할 수 있습니다.',
  },
  {
    id: 'sample-05', title: '공유 공간 예약 달력', category: '자원 관리', team: '행정지원팀', mode: '웹앱 예시',
    problem: '회의실 예약을 각자 다른 문서에 적어 같은 시간에 겹치는 상황을 줄입니다.',
    description: '날짜와 인원에 맞는 공간을 고르고 예약이 겹치는지 확인하는 달력형 도구입니다.',
    features: ['공간별 일간·주간 달력', '예약 시간 중복 검사', '정원과 필요 장비로 공간 찾기'],
    input: '수요일 14:00~15:00 / 참석 8명 / 화면 공유 장비 필요',
    output: '조건에 맞는 공간 2개를 표시합니다. 이미 예약된 공간은 겹치는 시간과 함께 선택 불가로 안내합니다.',
    limit: '예시 데이터에서는 예약 충돌을 검사하지만, 여러 기기가 동시에 저장할 때의 처리는 아직 시험하지 않았습니다.',
    expansion: '회의실 외에 공용 차량, 촬영 장비와 교육장 예약에도 활용할 수 있습니다.',
  },
  {
    id: 'sample-06', title: '지출 내역 분류 도우미', category: '자료 정리', team: '예산지원팀', mode: '로컬 실행 예시',
    problem: '월별 지출 CSV의 서로 다른 항목명을 통일하고 집계하는 수작업을 줄입니다.',
    description: '항목 분류 규칙을 적용하고 미분류 행을 사람이 확인한 뒤 항목별 합계를 만드는 도구입니다.',
    features: ['CSV 열 연결과 형식 검사', '키워드 기반 항목 분류', '미분류·중복 의심 행 별도 표시'],
    input: '사무용 종이 12,000원 / 회의 자료 인쇄 18,000원 / 기타 5,000원',
    output: '사무용품 12,000원, 인쇄비 18,000원으로 집계하고 “기타 5,000원”은 검토 목록에 남깁니다.',
    limit: 'CSV만 지원하며, 잘못된 분류 규칙을 자동으로 판단하지는 못합니다.',
    expansion: '분류 규칙을 바꾸어 구매 내역, 물품 목록, 교육비 집계에도 사용할 수 있습니다.',
  },
  {
    id: 'sample-07', title: '쉬운 공문 표현 도우미', category: '문서 작성', team: '홍보지원팀', mode: '웹앱 예시',
    problem: '어려운 행정 표현이 들어간 안내문을 주민이 이해하기 쉬운 문장으로 고치는 일을 돕습니다.',
    description: '어려운 표현의 대안을 제시하고 바뀐 부분을 표시하여 작성자가 채택 여부를 결정하는 도구입니다.',
    features: ['행정 용어 대안 표시', '원문과 수정안 나란히 보기', '숫자·날짜 변경 여부 확인'],
    input: '해당 구비서류를 지참하시어 내방하여 주시기 바랍니다.',
    output: '필요한 서류를 가지고 방문해 주세요. “구비서류”, “지참”, “내방”을 바꾼 부분으로 표시합니다.',
    limit: '예시 표현 사전에 없는 긴 문장은 다루지 못하며, 문서 전체의 의미 일치 여부는 작성자가 확인해야 합니다.',
    expansion: '민원 안내문, 행사 공지, 누리집 도움말의 표현을 일관되게 다듬는 데 적용할 수 있습니다.',
  },
  {
    id: 'sample-08', title: '다국어 생활 안내 카드', category: '주민 소통', team: '다문화지원팀', mode: '웹앱 예시',
    problem: '생활 안내를 여러 언어로 준비할 때 같은 정보가 언어별로 다르게 전달되는 문제를 줄입니다.',
    description: '행사 장소·시간·준비물을 구조화해 입력하고 미리 검토한 문구로 다국어 안내 카드를 구성합니다.',
    features: ['시간·장소를 공통 입력값으로 관리', '언어별 카드 미리보기', '검토 완료 문구만 선택'],
    input: '생활 안내 교육 / 토요일 10:00 / 주민센터 교육실 / 준비물: 필기도구',
    output: '같은 시간·장소·준비물 정보를 사용한 한국어·영어 안내 카드 2종을 나란히 보여줍니다.',
    limit: '예시에서는 두 언어와 교육 안내 문구만 지원하며, 자유 문장 번역은 제공하지 않습니다.',
    expansion: '도서관, 체육시설, 주민 교육 등 반복되는 생활 안내 문구를 추가할 수 있습니다.',
  },
  {
    id: 'sample-09', title: '주민 설문 한눈에 보기', category: '의견 분석', team: '정책기획팀', mode: '로컬 실행 예시',
    problem: '설문 응답을 표로 정리하고 자주 등장한 의견을 찾는 데 걸리는 시간을 줄입니다.',
    description: '응답 CSV에서 선택형 문항을 집계하고 자유 의견의 키워드를 원문과 함께 보여주는 도구입니다.',
    features: ['문항별 응답 수·비율 표시', '빈 응답과 중복 의심 행 분리', '키워드를 눌러 관련 원문 확인'],
    input: '응답 20건 / 만족 12건, 보통 5건, 불만족 3건 / 자유 의견에 “운영 시간” 4회',
    output: '만족 60%, 보통 25%, 불만족 15%와 함께 “운영 시간”이 나온 의견 4건을 보여줍니다.',
    limit: '같은 뜻의 다른 표현을 합치지 못하며, 응답 수가 적은 항목을 별도로 표시하는 기능은 없습니다.',
    expansion: '교육 만족도, 행사 후기, 시설 이용 의견 등 비슷한 구조의 설문에 적용할 수 있습니다.',
  },
  {
    id: 'sample-10', title: '업무 인수인계 체크보드', category: '협업', team: '조직지원팀', mode: '웹앱 예시',
    problem: '담당자 변경 때 반복 업무의 기한과 확인 사항이 빠지는 일을 줄입니다.',
    description: '업무별 주기, 다음 기한과 확인 목록을 정리하고 인계·인수 확인을 구분하는 체크보드입니다.',
    features: ['반복 업무별 체크리스트', '인계 확인과 인수 확인 구분', '기한이 가까운 업무 순서로 보기'],
    input: '월간 실적 취합 / 매월 5일 / 확인 사항: 자료 요청, 취합, 누락 확인, 보고',
    output: '다음 기한이 있는 업무 카드와 확인 항목 4개를 표시합니다. 인계 완료·인수 확인은 따로 체크합니다.',
    limit: '예시에서는 목록을 한 기기에서 관리하며, 변경 이력과 담당자별 접근 권한은 구현되지 않았습니다.',
    expansion: '부서 공통 업무 양식을 만들면 정기 인사이동과 신규 담당자 교육에 함께 활용할 수 있습니다.',
  },
];

const sum = (scores) => scores.reduce((total, score) => total + score, 0);
const fresh = () => ({ version: 1, selectedId: SAMPLES[0].id, scores: {} });

function loadPractice(key) {
  const state = fresh();
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!saved || saved.version !== 1) return state;
    if (SAMPLES.some((sample) => sample.id === saved.selectedId)) state.selectedId = saved.selectedId;
    for (const sample of SAMPLES) {
      if (validScores(saved.scores?.[sample.id])) state.scores[sample.id] = [...saved.scores[sample.id]];
    }
  } catch { /* 잘못된 연습 기록이 실제 사이트 이용을 막지 않게 새로 시작합니다. */ }
  return state;
}

function exampleHtml(sample) {
  return `<div class="festa-practice-example card--flat">
    <h3 style="font-size:1.6rem">작동 예시</h3>
    <p class="field__hint">설명용으로 만든 입력과 결과입니다. 실제 서비스를 실행하는 화면은 아닙니다.</p>
    <dl style="margin-top:var(--space-3)">
      <dt><strong>예시 입력</strong></dt><dd style="margin:var(--space-2) 0 var(--space-3)">${esc(sample.input)}</dd>
      <dt><strong>예시 결과</strong></dt><dd style="margin:var(--space-2) 0 0">${esc(sample.output)}</dd>
    </dl>
  </div>`;
}

function resultsHtml(state) {
  const scored = SAMPLES.filter((sample) => validScores(state.scores[sample.id]))
    .map((sample) => ({ ...sample, scores: state.scores[sample.id], total: sum(state.scores[sample.id]) }))
    .sort((a, b) => b.total - a.total);
  let previous;
  let rank = 0;
  return `<section class="card" aria-labelledby="practiceResultsTitle" data-testid="practice-results">
    <div class="festa-entry-head"><div><h2 id="practiceResultsTitle" class="page-title" style="font-size:2.2rem">내 연습 결과</h2><p class="page-sub">저장한 샘플만 총점 순으로 표시합니다. 실제 행사 순위와 무관한 개인 연습 결과입니다.</p></div>
      <button type="button" class="btn btn--outline" data-testid="practice-reset-all" ${scored.length ? '' : 'disabled'}>전체 연습 다시 하기</button></div>
    <div class="festa-practice-result-list" style="margin-top:var(--space-4)">${scored.length ? scored.map((sample, index) => {
      if (sample.total !== previous) rank = index + 1;
      previous = sample.total;
      return `<article class="festa-practice-result-row" data-testid="practice-result-row" data-result-id="${sample.id}">
        <div class="grow"><span class="badge badge--soft">연습 ${rank}위</span><h3 style="font-size:1.7rem;margin-top:var(--space-2)">${esc(sample.title)}</h3>
          <p class="field__hint">${RUBRIC.map((rule, i) => `${rule.name} ${sample.scores[i]}/${rule.max}`).join(' · ')}</p></div>
        <strong class="festa-total" data-testid="practice-result-total">${sample.total} / 100점</strong>
        <button type="button" class="btn btn--quiet btn--sm" data-select-sample="${sample.id}" aria-label="${attr(sample.title)} 다시 채점">다시 채점</button>
      </article>`;
    }).join('') : '<p class="notice notice--info" data-testid="practice-results-empty">아직 저장한 평가가 없습니다. 샘플을 선택해 네 항목의 점수를 입력하고 저장해 보세요.</p>'}</div>
  </section>`;
}

export function festaPracticeView(mount) {
  const member = currentUser();
  if (!member || !isAdmin()) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '관리자만 이용할 수 있습니다', body: '샘플 심사 연습은 관리자 전용입니다.',
      action: '<a class="btn btn--outline" href="#/">홈으로 돌아가기</a>',
    })}</div></section>`;
    return;
  }
  const key = `ah.festaPractice.v1:${encodeURIComponent(String(member.email).trim().toLowerCase())}:${encodeURIComponent(member.createdAt || '')}`;
  let state = loadPractice(key);
  let persistenceAvailable = true;
  const persist = () => {
    try { sessionStorage.setItem(key, JSON.stringify(state)); return true; }
    catch { persistenceAvailable = false; return false; }
  };

  function render(message = '') {
    const selected = SAMPLES.find((sample) => sample.id === state.selectedId) || SAMPLES[0];
    const saved = state.scores[selected.id];
    const allScores = Object.values(state.scores).filter(validScores);
    const average = allScores.length ? (allScores.reduce((total, scores) => total + sum(scores), 0) / allScores.length).toFixed(1) : '—';
    mount.innerHTML = `<div class="festa-practice">
      <section class="band festa-hero"><div class="wrap">
        <p class="crumb"><a href="#/admin/festa" style="color:inherit">페스타 관리</a><span>/</span>샘플 심사 연습</p>
        <span class="badge badge--gold">관리자 전용 · 연습용</span>
        <h1 style="font-size:clamp(2.4rem,5vw,3.4rem);color:inherit;margin-top:var(--space-3)">샘플 심사 연습</h1>
        <p style="margin-top:var(--space-2)">가상 작품 10개를 살펴보고, 네 가지 기준으로 평가를 연습하세요.</p>
        <a class="btn btn--ghostDark" href="#/admin/festa" style="margin-top:var(--space-3)">접수 현황으로 돌아가기</a>
      </div></section>
      <section class="section"><div class="wrap festa-stack" data-testid="practice-root">
        <div class="notice notice--info" data-testid="practice-notice"><div><strong>아래 작품과 소속은 모두 가상의 샘플입니다.</strong><p>여기서 저장한 점수는 실제 접수·심사 결과에 포함되지 않습니다. 연습 기록은 현재 브라우저 탭에서 관리자 계정별로 유지됩니다. 이 탭을 닫으면 기록이 사라질 수 있습니다.</p></div></div>
        ${persistenceAvailable ? '' : '<p class="notice notice--warn">이 브라우저에서는 연습 기록을 보관할 수 없습니다. 현재 화면에서 연습할 수 있지만 화면을 떠나면 기록이 사라집니다.</p>'}
        <div class="stat-row festa-practice-summary" data-testid="practice-summary">${stat(10, '가상 작품')}${stat(`${allScores.length} / 10`, '평가 완료')}${stat(average, '내 연습 평균 · 100점 만점')}</div>
        <div class="festa-practice-layout">
          <section class="card" aria-labelledby="practiceListTitle"><h2 id="practiceListTitle" class="page-title" style="font-size:2rem">샘플 작품 목록</h2><p class="field__hint">작품을 선택하면 설명과 채점란이 열립니다.</p>
            <div class="festa-practice-list" data-testid="practice-list" style="margin-top:var(--space-3)">${SAMPLES.map((sample, index) => {
              const scores = state.scores[sample.id];
              return `<button type="button" class="festa-practice-choice ${selected.id === sample.id ? 'is-selected' : ''}" data-testid="practice-choice" data-select-sample="${sample.id}" aria-pressed="${selected.id === sample.id}"><span class="field__hint">샘플 ${String(index + 1).padStart(2, '0')} · ${esc(sample.category)}</span><strong>${esc(sample.title)}</strong><span class="field__hint">${validScores(scores) ? `평가 완료 · ${sum(scores)} / 100점` : '아직 평가하지 않음'}</span></button>`;
            }).join('')}</div>
          </section>
          <section class="card festa-stack" data-testid="practice-detail" aria-labelledby="practiceDetailTitle">
            <div><span class="badge badge--soft">${esc(selected.category)} · ${esc(selected.mode)}</span><h2 id="practiceDetailTitle" class="page-title" style="font-size:2.3rem;margin-top:var(--space-3)" tabindex="-1">${esc(selected.title)}</h2><p class="page-sub">가상 소속: ${esc(selected.team)} · 설명용 샘플</p></div>
            <div><h3 style="font-size:1.7rem">해결하려는 문제</h3><p>${esc(selected.problem)}</p></div>
            <div><h3 style="font-size:1.7rem">작품 설명</h3><p>${esc(selected.description)}</p><ul style="margin:var(--space-3) 0 0;padding-left:2rem">${selected.features.map((feature) => `<li>${esc(feature)}</li>`).join('')}</ul></div>
            ${exampleHtml(selected)}
            <div><h3 style="font-size:1.7rem">평가할 때 살펴볼 점</h3><p>${esc(selected.limit)}</p><p style="margin-top:var(--space-2)"><strong>확장 아이디어:</strong> ${esc(selected.expansion)}</p></div>
            <form data-testid="practice-score-form" data-sample-id="${selected.id}">
              <fieldset style="border:0;padding:0;margin:0;min-width:0"><legend class="field__label">${saved ? '저장한 연습 평가 수정' : '이 샘플 평가하기'} · 총 100점</legend>
                <div class="festa-score-grid" style="margin-top:var(--space-3)">${RUBRIC.map((rule, index) => `<label class="field"><span class="field__label">${rule.name} (0~${rule.max}점)</span><span class="field__hint">${rule.description}</span><input class="input" type="number" name="score${index}" min="0" max="${rule.max}" step="1" required inputmode="numeric" value="${saved ? saved[index] : ''}" /></label>`).join('')}</div>
                <div class="row row--between"><p class="festa-total" data-testid="practice-total" aria-live="polite">${saved ? `합계 ${sum(saved)} / 100점` : '네 항목의 점수를 입력해 주세요.'}</p><div class="row"><button type="submit" class="btn btn--primary" data-testid="practice-save">${saved ? '연습 평가 수정' : '연습 평가 저장'}</button><button type="button" class="btn btn--quiet" data-testid="practice-reset-one" ${saved ? '' : 'disabled'}>이 작품 다시 하기</button></div></div>
              </fieldset>
              <p class="field__hint" style="margin-top:var(--space-3)">0점도 입력할 수 있습니다. 실제 작품 제출이나 심사 점수로 전송되지 않습니다.</p>
              <p role="status" aria-live="polite" tabindex="-1" data-testid="practice-status">${esc(message)}</p>
            </form>
          </section>
        </div>
        ${resultsHtml(state)}
      </div></section>
    </div>`;

    const form = mount.querySelector('[data-testid="practice-score-form"]');
    const total = form.querySelector('[data-testid="practice-total"]');
    const status = form.querySelector('[data-testid="practice-status"]');
    const readInputs = () => RUBRIC.map((_, index) => {
      const value = form.elements[`score${index}`].value;
      return value === '' ? null : Number(value);
    });
    form.addEventListener('input', () => {
      const scores = readInputs();
      total.textContent = validScores(scores) ? `합계 ${sum(scores)} / 100점` : '항목별 범위 안의 정수 점수 네 개를 입력해 주세요.';
      status.textContent = '변경한 점수는 저장 버튼을 눌러야 연습 결과에 반영됩니다.';
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const scores = readInputs();
      if (!validScores(scores)) { status.textContent = '네 항목 모두 허용 범위의 정수로 입력해 주세요.'; return; }
      state.scores[selected.id] = scores;
      const stored = persist();
      render(stored ? '연습 평가를 저장했습니다. 아래 내 연습 결과에서도 확인할 수 있습니다.' : '현재 화면에 평가를 반영했습니다. 탭에 기록을 보관하지 못했습니다.');
      mount.querySelector('[data-testid="practice-status"]').focus({ preventScroll: true });
    });
    mount.querySelectorAll('[data-select-sample]').forEach((button) => button.addEventListener('click', () => {
      state.selectedId = button.dataset.selectSample;
      persist();
      render();
      const heading = mount.querySelector('#practiceDetailTitle');
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
    form.querySelector('[data-testid="practice-reset-one"]').addEventListener('click', async () => {
      const confirmed = await confirmModal({ title: '이 샘플을 다시 평가할까요?',
        body: `“${selected.title}”의 연습 점수만 지웁니다. 다른 샘플의 점수는 유지됩니다.`, confirmLabel: '이 작품 점수 지우기' });
      if (!confirmed || !mount.querySelector('[data-testid="practice-root"]')) return;
      delete state.scores[selected.id];
      persist();
      render('이 샘플의 연습 점수를 지웠습니다. 네 항목을 다시 입력해 보세요.');
      mount.querySelector('[name="score0"]').focus({ preventScroll: true });
    });
    mount.querySelector('[data-testid="practice-reset-all"]').addEventListener('click', async () => {
      const confirmed = await confirmModal({ title: '전체 연습을 처음부터 할까요?',
        body: '현재 관리자 계정의 샘플 평가만 모두 지웁니다. 실제 접수와 심사 결과는 바뀌지 않습니다.', confirmLabel: '전체 연습 점수 지우기' });
      if (!confirmed || !mount.querySelector('[data-testid="practice-root"]')) return;
      state = fresh();
      persist();
      render('연습 점수를 모두 지웠습니다. 첫 번째 샘플부터 다시 시작하세요.');
      mount.querySelector('#practiceDetailTitle').focus({ preventScroll: true });
    });
  }
  render();
}
