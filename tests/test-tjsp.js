// Validação local do scraper TJSP eSAJ cjsg (npm run test:tjsp).
import { run } from './_harness.js';

const termo = process.argv[2] || 'dano moral consumidor';
const headful = process.argv[3] === 'headful';

run('tjsp', termo, { headful })
  .then((r) => {
    console.log('\n>>> JSON:', JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => { console.error(e); process.exit(3); });
