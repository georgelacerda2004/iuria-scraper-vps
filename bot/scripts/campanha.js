#!/usr/bin/env node
// Uso: node scripts/campanha.js rascunho | ciclo | relatorio
// Precisa de META_ADS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID (e SUPABASE_* para cruzar com o CRM).
import 'dotenv/config';
import { criarRascunho, ciclo } from '../lib/campanha.js';
const cmd = process.argv[2];
if (cmd === 'rascunho') {
  const r = await criarRascunho({ mensagemBoasVindas: 'Olá! Vi o anúncio sobre a Lei do Superendividamento e quero entender se o meu caso se enquadra.' });
  console.log('Rascunho criado (tudo PAUSADO). Ative no Gerenciador de Anúncios depois de revisar:', JSON.stringify(r, null, 2));
} else if (cmd === 'ciclo' || cmd === 'relatorio') {
  const r = await ciclo({ dryRun: cmd === 'relatorio' ? true : undefined });
  console.log(r.relatorio);
} else { console.log('comandos: rascunho | ciclo | relatorio'); process.exit(1); }
