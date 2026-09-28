const feedSugeridoService = require('../services/feedSugeridoService');
const { PLATAFORMAS, ROTULOS, lerConfig, salvarConfig, statusCookies } = require('../services/feedSugeridoConfig');

function responderErro(res, next, err) {
  if (err?.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  return next(err);
}

/** Redes liberadas pelo admin + situação dos cookies, para o modal do editor. */
async function config(req, res, next) {
  try {
    const cfg = await lerConfig();
    const cookies = statusCookies();
    res.json({
      plataformas: PLATAFORMAS.map((id) => ({
        id,
        nome: ROTULOS[id],
        habilitada: cfg.plataformas[id],
        cookiesOk: Boolean(cookies[id]?.ok),
      })),
      maxPorRede: cfg.maxPorRede,
      temaPadrao: cfg.temaPadrao,
    });
  } catch (err) {
    next(err);
  }
}

async function listar(req, res, next) {
  try {
    res.json({ jobs: await feedSugeridoService.listarJobs(req.session.userId) });
  } catch (err) {
    next(err);
  }
}

async function criar(req, res, next) {
  try {
    const job = await feedSugeridoService.criarJob(req.session.userId, req.body || {});
    res.status(201).json({ job });
  } catch (err) {
    responderErro(res, next, err);
  }
}

async function obter(req, res, next) {
  try {
    res.json({ job: await feedSugeridoService.obterJob(req.session.userId, Number(req.params.id)) });
  } catch (err) {
    responderErro(res, next, err);
  }
}

async function escolher(req, res, next) {
  try {
    const job = await feedSugeridoService.escolherItens(
      req.session.userId,
      Number(req.params.id),
      req.body?.itens || [],
      { modelo: req.body?.modelo }
    );
    res.json({ job });
  } catch (err) {
    responderErro(res, next, err);
  }
}

async function cancelar(req, res, next) {
  try {
    res.json({ job: await feedSugeridoService.cancelarJob(req.session.userId, Number(req.params.id)) });
  } catch (err) {
    responderErro(res, next, err);
  }
}

// ------------------------------------------------------------ administração

async function paginaAdmin(req, res, next) {
  try {
    res.render('config-feed-sugerido', {
      title: 'Feed sugerido',
      config: await lerConfig(),
      cookies: statusCookies(),
      rotulos: ROTULOS,
      plataformas: PLATAFORMAS,
    });
  } catch (err) {
    next(err);
  }
}

async function salvarAdmin(req, res, next) {
  try {
    const corpo = req.body || {};
    const salvo = await salvarConfig({
      plataformas: corpo.plataformas || {},
      maxPorRede: corpo.maxPorRede,
      temaPadrao: corpo.temaPadrao,
    });
    res.json({ config: salvo });
  } catch (err) {
    responderErro(res, next, err);
  }
}

module.exports = { config, listar, criar, obter, escolher, cancelar, paginaAdmin, salvarAdmin };
