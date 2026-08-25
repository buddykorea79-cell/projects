import { parse } from 'acorn';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = execSync(
  `find ${root}/assets/js ${root}/worker ${root}/shared ${root}/functions -name '*.js'`,
).toString().trim().split('\n');
let bad = 0;
for (const f of files) {
  try {
    parse(readFileSync(f, 'utf8'), { ecmaVersion: 2023, sourceType: 'module' });
    console.log(`  ok   ${f.replace(root + '/', '')}`);
  } catch (e) {
    bad++;
    console.log(`  FAIL ${f.replace(root + '/', '')} — ${e.message}`);
  }
}
// 파서가 실제로 오류를 잡는지 확인
try { parse('export const a = ;', { ecmaVersion: 2023, sourceType: 'module' }); console.log('\n파서 신뢰 불가 — 잘못된 코드를 통과시킴'); process.exit(1); }
catch { console.log('\n파서 정상 (의도적 오류를 잡음)'); }
process.exit(bad ? 1 : 0);
