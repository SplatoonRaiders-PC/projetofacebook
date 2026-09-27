const db = require('../config/db');

/**
 * Configuração global do Feed sugerido (só o administrador altera).
 * Fica em app_settings.chave = 'feed_sugerido' como JSON.
 */

const CHAVE = 'feed_sugerido';
const PLATAFORMAS = ['instagram', 'youtube', 'facebook'];
const ROTULOS = { instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook' };
const CACHE_MS = 15_000;

const PADRAO = {
  plataformas: { instagram: false, youtube: false, facebook: false },
  maxPorRede: 10,
  temaPadrao: '',
};

let cache = null;

function erroDeTabelaAusente(err) {
  return err?.code === 'ER_NO_SUCH_TABLE' || /no such table|doesn't exist/i.test(String(err?.message || ''));
}

function normalizar(bruto = {}) {
  const plataformas = {};
  for (const rede of PLATAFORMAS) plataformas[rede] = Boolean(bruto?.plataformas?.[rede]);
  const max = Math.round(Number(bruto?.maxPorRede));
  return {
    plataformas,
    maxPorRede: Number.isFinite(max) ? Math.min(Math.max(max, 1), 30) : PADRAO.maxPorRede,
    temaPadrao: String(bruto?.temaPadrao || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

async function lerConfig() {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.valor;
  let valor = normalizar(PADRAO);
  try {
    const linha = await db('app_settings').where({ chave: CHAVE }).first();
    if (linha?.valor) valor = normalizar(JSON.parse(linha.valor));
  } catch (err) {
    if (!erroDeTabelaAusente(err)) throw err;
  }
  cache = { valor, em: Date.now() };
  return valor;
}

async function salvarConfig(entrada) {
  const valor = normalizar(entrada);
  const json = JSON.stringify(valor);
  const existe = await db('app_settings').where({ chave: CHAVE }).first();
  if (existe) {
    await db('app_settings').where({ chave: CHAVE }).update({ valor: json, updated_at: db.fn.now() });
  } else {
    await db('app_settings').insert({ chave: CHAVE, valor: json });
  }
  cache = { valor, em: Date.now() };
  return valor;
}

/**
 * Situação dos cookies de cada rede, só pelo arquivo (sem acesso remoto:
 * testar login a toda hora é o que faz a Meta bloquear a conta).
 */
function statusCookies() {
  const status = {};
  try {
    const d = require('./instagramCookies').diagnoseInstagramCookies();
    status.instagram = { ok: Boolean(d.ok), motivo: d.reason || null };
  } catch (err) {
    status.instagram = { ok: false, motivo: err.message };
  }
  try {
    const d = require('./facebookCookies').diagnoseFacebookCookies();
    status.facebook = { ok: Boolean(d.ok), motivo: d.reason || null };
  } catch (err) {
    status.facebook = { ok: false, motivo: err.message };
  }
  try {
    const flags = require('./ytDlpAuth').getYtDlpAuthFlags({ platform: 'youtube' });
    status.youtube = flags?.cookies
      ? { ok: true, motivo: 'arquivo de cookies encontrado' }
      : { ok: false, motivo: 'cookies do YouTube não configurados (cadastre em Cookies YouTube)' };
  } catch (err) {
    status.youtube = { ok: false, motivo: err.message };
  }
  return status;
}

module.exports = {
  PLATAFORMAS,
  ROTULOS,
  lerConfig,
  salvarConfig,
  statusCookies,
};
