/**
 * 브라우저 테스트가 쓸 크로미움 찾기.
 *
 * 이 환경에는 크로미움이 미리 깔려 있는데, 경로에 **버전 번호가 들어가** 있어서
 * (`/opt/pw-browsers/chromium-1243/…`) 컨테이너가 바뀌면 어제 돌던 테스트가
 * "Executable doesn't exist" 로 멈춥니다. 그래서 버전을 박아두지 않고
 * 순서대로 찾습니다 —
 *   ① CHROME_PATH 환경변수
 *   ② /opt/pw-browsers/chromium (버전이 바뀌어도 그대로인 심링크)
 *   ③ chromium-<버전> 폴더를 훑어 가장 새 것
 *   ④ 하나도 없으면 빈 옵션 — playwright 가 자기 경로에서 찾습니다
 *      (`npx playwright install chromium` 으로 받은 경우)
 */
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

function discover() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const link = join(ROOT, 'chromium');
  if (existsSync(link)) return link;

  let dirs = [];
  try {
    dirs = readdirSync(ROOT).filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  } catch { return ''; }

  for (const dir of dirs) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const path = join(ROOT, dir, sub, 'chrome');
      if (existsSync(path)) return path;
    }
  }
  return '';
}

/** chromium.launch() 에 그대로 넘기는 옵션. 못 찾으면 빈 객체입니다. */
export function chromeOptions(extra = {}) {
  const executablePath = discover();
  return executablePath && existsSync(executablePath)
    ? { executablePath, ...extra }
    : { ...extra };
}
