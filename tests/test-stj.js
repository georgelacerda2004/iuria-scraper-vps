// Validação local do scraper STJ (npm run test:stj).
// Termos de exemplo: jurisprudência consumerista e previdenciária.
import { run } from './_harness.js';

const termo = process.argv[2] || 'dano moral consumidor';
const headful = process.argv[3] === 'headful';

run('stj', termo, { headful })
  .then((r) => {
    console.log('\n>>> JSON:', JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  })
  .catch((e) => { console.error(e); process.exit(3); });
