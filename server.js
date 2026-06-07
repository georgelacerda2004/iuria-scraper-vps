// IURIA Scraper VPS — servidor central de scraping de jurisprudência.
//
// Cada endpoint POST /buscar/:tribunal usa Playwright headless pra navegar
// no site oficial do tribunal e retornar acórdãos padronizados.
//
// Por que Playwright e não fetch HTTP simples? Porque os tribunais brasileiros
// (STF/STJ/TST/TJSP/etc) instalaram Cloudflare anti-bot que bloqueia requests
// sem JavaScript habilitado. Playwright = browser real = passa pelo desafio.
//
// Cache Redis 24h: buscas repetidas respondem em <50ms (o trabalho de scraping
// é feito 1x, depois fica em memória do Redis).
//
// Auth: Bearer token simples (mesmo formato que Anthropic / OpenAI usam).
// O Supabase Edge Function chama com header "Authorization: Bearer <token>".

import express from 'express';
import morgan from 'morgan';
import compression from 'compression';
import { chromium } from 'playwright';
import Redis from 'ioredis';
import { stj } from './scrapers/stj.js';
import { tjsp } from './scrapers/tjsp.js';
import { stf } from './scrapers/stf.js';
import { tst } from './scrapers/tst.js';
import { tjpe } from './scrapers/tjpe.js';
import { tjmg } from './scrapers/tjmg.js';
import { tjrj } from './scrapers/tjrj.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const AUTH_TOKEN = process.env.IURIA_SCRAPER_TOKEN || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL || '86400', 10); // 24h

if (!AUTH_TOKEN) {
  console.error('FATAL: IURIA_SCRAPER_TOKEN environment variable required');
  process.exit(1);
}

// ===== Browser persistente =====
// Mantém UMA instância de browser viva. Cada request usa um novo context (cookies
// isolados) mas reusa o processo. Muito mais rápido do que spawn por request.
let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('[browser] launching new instance');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // crítico em containers Docker (shm pequena)
      '--disable-blink-features=AutomationControlled', // disfarce anti-bot
      '--disable-gpu',
    ],
  });
  browser.on('disconnected', () => {
    console.log('[browser] disconnected — will relaunch on next request');
    browser = null;
  });
  return browser;
}

// ===== Cache Redis =====
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});
redis.on('error', (err) => console.warn('[redis] error:', err.message));
redis.on('connect', () => console.log('[redis] connected'));

function cacheKey(tribunal, busca, opts = {}) {
  const k = `${tribunal}|${busca.toLowerCase()}|${opts.dataIni || ''}|${opts.dataFim || ''}`;
  return `juris:${Buffer.from(k).toString('base64').slice(0, 64)}`;
}

// ===== Express app =====
const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// Health check (não exige auth — pra Caddy/load balancer probar)
app.get('/health', async (req, res) => {
  try {
    const ping = await redis.ping();
    const b = browser && browser.isConnected();
    res.json({ status: 'ok', redis: ping, browser: b ? 'connected' : 'cold', uptime: process.uptime() });
  } catch (e) {
    res.status(503).json({ status: 'degraded', error: e.message });
  }
});

// Middleware de auth pros endpoints reais
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Lista de tribunais com extractor próprio
const SCRAPERS = {
  stj, tjsp, stf, tst, tjpe, tjmg, tjrj,
};

app.get('/tribunais', requireAuth, (req, res) => {
  res.json({
    tribunais: Object.keys(SCRAPERS).map(t => t.toUpperCase()),
    total: Object.keys(SCRAPERS).length,
  });
});

// Endpoint principal: POST /buscar/:tribunal
// Body: { busca: string, dataIni?: "YYYY-MM-DD", dataFim?: "YYYY-MM-DD", noCache?: bool, limit?: number }
app.post('/buscar/:tribunal', requireAuth, async (req, res) => {
  const tribunal = (req.params.tribunal || '').toLowerCase();
  const { busca, dataIni, dataFim, noCache, limit = 15 } = req.body || {};

  if (!busca || typeof busca !== 'string' || busca.trim().length < 2) {
    return res.status(400).json({ error: 'busca obrigatória (mínimo 2 caracteres)' });
  }
  const scraper = SCRAPERS[tribunal];
  if (!scraper) {
    return res.status(404).json({ error: `tribunal ${tribunal} sem scraper. Disponíveis: ${Object.keys(SCRAPERS).join(', ')}` });
  }

  const key = cacheKey(tribunal, busca.trim(), { dataIni, dataFim });

  // Cache hit?
  if (!noCache) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        const data = JSON.parse(cached);
        return res.json({ ...data, cache: 'hit', cacheKey: key });
      }
    } catch (e) {
      console.warn('[cache] read error:', e.message);
    }
  }

  // Cache miss — chama scraper
  const t0 = Date.now();
  try {
    const b = await getBrowser();
    const resultados = await scraper(b, { busca: busca.trim(), dataIni, dataFim, limit });
    const tempo_ms = Date.now() - t0;
    const payload = {
      tribunal: tribunal.toUpperCase(),
      busca,
      total: resultados.length,
      tempo_ms,
      resultados,
      cache: 'miss',
      cacheKey: key,
    };
    // Grava em cache (best-effort)
    try {
      await redis.set(key, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
    } catch (e) {
      console.warn('[cache] write error:', e.message);
    }
    res.json(payload);
  } catch (err) {
    const tempo_ms = Date.now() - t0;
    console.error(`[${tribunal}] scraper error after ${tempo_ms}ms:`, err.message);
    res.status(500).json({
      error: err.message,
      tribunal: tribunal.toUpperCase(),
      tempo_ms,
    });
  }
});

// ===== Startup =====
app.listen(PORT, () => {
  console.log(`[iuria-scraper] listening on :${PORT}`);
  console.log(`[iuria-scraper] tribunais: ${Object.keys(SCRAPERS).join(', ')}`);
  console.log(`[iuria-scraper] cache TTL: ${CACHE_TTL_SECONDS}s`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[shutdown] SIGTERM');
  if (browser) await browser.close();
  await redis.quit();
  process.exit(0);
});
