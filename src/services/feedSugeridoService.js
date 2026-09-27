const db = require('../config/db');
const { env } = require('../config/env');
const { PLATAFORMAS, ROTULOS, lerConfig } = require('./feedSugeridoConfig');
const { coletarSugeridos, pausaHumana } = require('./feedSugeridoColetor');

/**
 * Feed sugerido → matérias.
 *
 * O editor escolhe as redes (entre as que o admin liberou) e quantos vídeos
 * quer de cada uma. O sistema abre o feed de sugestões da conta dos cookies,
 * pega os N primeiros vídeos que ainda não viraram matéria, transcreve o
 * áudio e escreve uma matéria-rascunho para a página do Facebook escolhida.
 *
 * Um job por vez no servidor: transcrição é pesada e várias coletas em
 * paralelo com a mesma conta é o que faz Instagram/Facebook bloquearem.
 */

const JOBS = 'feed_sugerido_jobs';
const ITENS = 'feed_sugerido_itens';
const ATIVOS = ['na_fila', 'coletando', 'processando'];
const FINAIS_ITEM = ['pronto', 'ignorado', 'erro'];

const fila = [];
let rodando = false;

function erro(status, mensagem) {
  const e = new Error(mensagem);
  e.status = status;
  return e;
}

function parseJson(valor, padrao) {
  if (valor && typeof valor === 'object') return valor;
  try {
    return JSON.parse(valor || '');
  } catch {
    return padrao;
  }
}

function corta(valor, max) {
  const texto = String(valor ?? '').trim();
  return texto ? texto.slice(0, max) : null;
}

async function atualizarJob(id, dados) {
  await db(JOBS).where({ id }).update({ ...dados, updated_at: db.fn.now() });
}

async function atualizarItem(id, dados) {
  await db(ITENS).where({ id }).update({ ...dados, updated_at: db.fn.now() });
}

async function jobCancelado(id) {
  const job = await db(JOBS).where({ id }).first('status');
  return !job || job.status === 'cancelado';
}

// ------------------------------------------------------------------ criação

async function criarJob(userId, entrada = {}) {
  const config = await lerConfig();
  const pedidas = [...new Set((Array.isArray(entrada.plataformas) ? entrada.plataformas : [])
    .map((p) => String(p || '').toLowerCase()))]
    .filter((p) => PLATAFORMAS.includes(p));
  if (!pedidas.length) throw erro(400, 'Marque pelo menos uma rede.');
  const bloqueadas = pedidas.filter((p) => !config.plataformas[p]);
  if (bloqueadas.length) {
    throw erro(403, `O administrador não liberou: ${bloqueadas.map((p) => ROTULOS[p]).join(', ')}.`);
  }

  const quantidade = Math.round(Number(entrada.quantidade) || 10);
  if (quantidade < 1 || quantidade > config.maxPorRede) {
    throw erro(400, `Escolha de 1 a ${config.maxPorRede} vídeos por rede.`);
  }

  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  let page = null;
  if (entrada.facebookPageId) {
    page = await resolvePageForUser(userId, entrada.facebookPageId);
    if (!page) throw erro(400, 'Página do Facebook inválida. Escolha uma das suas páginas em /paginas.');
  } else {
    page = await defaultPageForUser(userId);
  }

  const ativo = await db(JOBS).where({ user_id: userId }).whereIn('status', ATIVOS).first('id');
  if (ativo) throw erro(409, 'Você já tem uma coleta em andamento. Aguarde terminar ou cancele.');

  const seeds = {};
  for (const rede of pedidas) {
    const link = String(entrada.links?.[rede] || '').trim();
    if (link && /^https?:\/\//i.test(link)) seeds[rede] = link.slice(0, 1000);
  }
  const opcoes = {
    seeds,
    tema: corta(entrada.tema, 120) || config.temaPadrao || '',
    tom: corta(entrada.tom, 30) || 'natural',
    pesquisarWeb: Boolean(entrada.pesquisarWeb),
  };

  const [id] = await db(JOBS).insert({
    user_id: userId,
    facebook_page_id: page?.id || null,
    plataformas: pedidas.join(','),
    quantidade,
    opcoes: JSON.stringify(opcoes),
    status: 'na_fila',
    mensagem: 'Na fila para começar…',
  });
  enfileirar(id);
  return obterJob(userId, id);
}

// --------------------------------------------------------------- consultas

function formatarJob(job, itens = null) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    plataformas: String(job.plataformas || '').split(',').filter(Boolean),
    quantidade: job.quantidade,
    facebook_page_id: job.facebook_page_id,
    total: job.total,
    concluidos: job.concluidos,
    falhas: job.falhas,
    mensagem: job.mensagem,
    opcoes: parseJson(job.opcoes, {}),
    coleta: parseJson(job.coleta, {}),
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    ...(itens ? { itens } : {}),
  };
}

async function obterJob(userId, id) {
  const job = await db(JOBS).where({ id, user_id: userId }).first();
  if (!job) throw erro(404, 'Coleta não encontrada.');
  const itens = await db(ITENS)
    .leftJoin('ai_matters', 'ai_matters.id', `${ITENS}.matter_id`)
    .where(`${ITENS}.job_id`, id)
    .orderBy(`${ITENS}.id`, 'asc')
    .select(
      `${ITENS}.id`,
      `${ITENS}.plataforma`,
      `${ITENS}.url`,
      `${ITENS}.titulo`,
      `${ITENS}.autor`,
      `${ITENS}.thumbnail`,
      `${ITENS}.status`,
      `${ITENS}.etapa`,
      `${ITENS}.erro`,
      `${ITENS}.matter_id`,
      'ai_matters.titulo as materia_titulo'
    );
  return formatarJob(job, itens);
}

async function listarJobs(userId, limite = 8) {
  const jobs = await db(JOBS).where({ user_id: userId }).orderBy('id', 'desc').limit(limite);
  return jobs.map((job) => formatarJob(job));
}

async function cancelarJob(userId, id) {
  const job = await db(JOBS).where({ id, user_id: userId }).first();
  if (!job) throw erro(404, 'Coleta não encontrada.');
  if (!ATIVOS.includes(job.status)) return obterJob(userId, id);
  await atualizarJob(id, { status: 'cancelado', mensagem: 'Cancelado pelo editor.', finished_at: db.fn.now() });
  await db(ITENS)
    .where({ job_id: id })
    .whereNotIn('status', FINAIS_ITEM)
    .update({ status: 'ignorado', etapa: 'Cancelado', updated_at: db.fn.now() });
  const idx = fila.indexOf(Number(id));
  if (idx >= 0) fila.splice(idx, 1);
  return obterJob(userId, id);
}

// --------------------------------------------------------------- execução

function enfileirar(id) {
  const numero = Number(id);
  if (!fila.includes(numero)) fila.push(numero);
  void drenarFila();
}

async function drenarFila() {
  if (rodando) return;
  rodando = true;
  try {
    while (fila.length) {
      const id = fila.shift();
      try {
        await executarJob(id);
      } catch (err) {
        console.error(`[feed-sugerido] job ${id}:`, err.message);
        await atualizarJob(id, {
          status: 'erro',
          mensagem: corta(err.message, 500),
          finished_at: db.fn.now(),
        }).catch(() => {});
      }
    }
  } finally {
    rodando = false;
  }
}

/** Externos que este usuário já transformou em matéria (não repete o vídeo). */
async function jaAproveitados(userId, plataforma) {
  const linhas = await db(ITENS)
    .where({ user_id: userId, plataforma })
    .whereIn('status', ['pronto', 'escrevendo', 'transcrevendo', 'lendo', 'pendente'])
    .select('external_id');
  return new Set(linhas.map((l) => String(l.external_id)));
}

async function coletar(job, opcoes) {
  const plataformas = String(job.plataformas).split(',').filter(Boolean);
  const coleta = {};
  let total = 0;
  for (const rede of plataformas) {
    if (await jobCancelado(job.id)) return;
    await atualizarJob(job.id, { mensagem: `Abrindo as sugestões do ${ROTULOS[rede]}…` });
    const usados = await jaAproveitados(job.user_id, rede);
    // Pede folga para compensar vídeos que já viraram matéria antes.
    const pedir = Math.min(50, job.quantidade + Math.min(usados.size, job.quantidade) + 3);
    const resultado = await coletarSugeridos(rede, {
      quantidade: pedir,
      seedUrl: opcoes.seeds?.[rede] || '',
      tema: opcoes.tema || '',
    });
    const novos = resultado.itens.filter((item) => !usados.has(String(item.externalId))).slice(0, job.quantidade);
    coleta[rede] = {
      encontrados: resultado.itens.length,
      novos: novos.length,
      repetidos: resultado.itens.length - resultado.itens.filter((i) => !usados.has(String(i.externalId))).length,
      origem: resultado.origem,
      motivo: resultado.motivo,
    };
    console.info(
      `[feed-sugerido] job ${job.id} ${rede}: ${resultado.itens.length} encontrados, ${novos.length} novos` +
        (resultado.motivo ? ` — ${resultado.motivo}` : '')
    );
    if (novos.length) {
      await db(ITENS).insert(
        novos.map((item) => ({
          job_id: job.id,
          user_id: job.user_id,
          plataforma: rede,
          external_id: String(item.externalId).slice(0, 64),
          url: String(item.url).slice(0, 1000),
          titulo: corta(item.titulo, 500),
          autor: corta(item.autor, 160),
          thumbnail: item.thumbnail || null,
          status: 'pendente',
          // Legenda e mídia direta ficam só na memória do job (URLs de CDN expiram).
          etapa: null,
        }))
      );
      for (const item of novos) extrasDoItem.set(`${job.id}:${rede}:${item.externalId}`, item);
    }
    total += novos.length;
  }
  await atualizarJob(job.id, { coleta: JSON.stringify(coleta), total });
}

/** Legenda e URL de mídia vindas da coleta (não vão para o banco). */
const extrasDoItem = new Map();

async function executarJob(id) {
  let job = await db(JOBS).where({ id }).first();
  if (!job || !ATIVOS.includes(job.status)) return;
  const opcoes = parseJson(job.opcoes, {});

  const jaTemItens = await db(ITENS).where({ job_id: id }).first('id');
  if (!jaTemItens) {
    await atualizarJob(id, { status: 'coletando', started_at: db.fn.now() });
    await coletar(job, opcoes);
    job = await db(JOBS).where({ id }).first();
    if (!job || job.status === 'cancelado') return;
  }

  const pendentes = await db(ITENS).where({ job_id: id, status: 'pendente' }).orderBy('id', 'asc');
  const totalGeral = await db(ITENS).where({ job_id: id }).count({ n: '*' }).first();
  if (!Number(totalGeral?.n)) {
    const coleta = parseJson(job.coleta, {});
    const motivos = Object.entries(coleta)
      .map(([rede, c]) => (c.motivo ? `${ROTULOS[rede]}: ${c.motivo}` : c.repetidos ? `${ROTULOS[rede]}: só vídeos já aproveitados` : null))
      .filter(Boolean);
    await atualizarJob(id, {
      status: 'erro',
      mensagem: corta(`Nenhum vídeo novo encontrado. ${motivos.join(' | ')}`, 500),
      finished_at: db.fn.now(),
    });
    return;
  }

  await atualizarJob(id, { status: 'processando' });
  for (let i = 0; i < pendentes.length; i += 1) {
    if (await jobCancelado(id)) return;
    const item = pendentes[i];
    await atualizarJob(id, {
      mensagem: `Vídeo ${i + 1} de ${pendentes.length} (${ROTULOS[item.plataforma]})…`,
    });
    const extra = extrasDoItem.get(`${id}:${item.plataforma}:${item.external_id}`) || {};
    extrasDoItem.delete(`${id}:${item.plataforma}:${item.external_id}`);
    let ok = false;
    try {
      ok = await processarItem(job, opcoes, item, extra);
    } catch (err) {
      console.warn(`[feed-sugerido] item ${item.id} (${item.url}):`, err.message);
      await atualizarItem(item.id, { status: 'erro', etapa: null, erro: corta(err.message, 500) });
    }
    await db(JOBS)
      .where({ id })
      .increment(ok ? 'concluidos' : 'falhas', 1);
    // Um respiro entre vídeos da Meta evita parecer robô.
    if (i < pendentes.length - 1 && item.plataforma !== 'youtube') await pausaHumana(3000, 7000);
  }

  if (await jobCancelado(id)) return;
  const final = await db(JOBS).where({ id }).first();
  await atualizarJob(id, {
    status: 'concluido',
    mensagem: `${final.concluidos} matéria(s) criada(s)${final.falhas ? `, ${final.falhas} vídeo(s) sem matéria` : ''}.`,
    finished_at: db.fn.now(),
  });
}

function rotuloDoVideo(plataforma) {
  if (plataforma === 'instagram') return 'Reel do Instagram';
  if (plataforma === 'youtube') return 'Short do YouTube';
  return 'vídeo do Facebook';
}

/** @returns {Promise<boolean>} true quando a matéria foi criada. */
async function processarItem(job, opcoes, item, extra) {
  let legenda = String(extra.legenda || '').trim();
  let thumbnail = item.thumbnail || extra.thumbnail || null;
  let autor = item.autor || extra.autor || null;
  let mediaUrl = extra.mediaUrl || null;
  let subtitleUrl = null;

  // 1) Legenda/capa do post (Instagram e Facebook) quando a coleta não trouxe.
  if (item.plataforma !== 'youtube' && (!legenda || !thumbnail)) {
    await atualizarItem(item.id, { status: 'lendo', etapa: 'Lendo a publicação…' });
    try {
      const { extrairPostSocial } = require('./socialPostExtract');
      const post = await extrairPostSocial(item.url);
      if (!legenda && post?.texto) legenda = String(post.texto).trim();
      if (!thumbnail && post?.imagem) thumbnail = post.imagem;
      if (!autor && post?.veiculo) autor = post.veiculo;
      if (!mediaUrl && post?.videoUrl) mediaUrl = post.videoUrl;
      if (post?.subtitleUrl) subtitleUrl = post.subtitleUrl;
    } catch (err) {
      console.info(`[feed-sugerido] sem dados do post ${item.url}: ${err.message}`);
    }
  }

  // 2) Fala do vídeo: legenda da plataforma ou, sem ela, só o áudio no Whisper.
  await atualizarItem(item.id, {
    status: 'transcrevendo',
    etapa: 'Transcrevendo o áudio…',
    thumbnail: thumbnail || null,
    autor: corta(autor, 160),
  });
  let transcricao = '';
  try {
    const { transcribeUrl, comLimiteDeTempo } = require('./transcriptionService');
    const resultado = await comLimiteDeTempo(
      transcribeUrl({
        sourceUrl: item.url,
        mediaUrl,
        subtitleUrl,
        contextText: legenda.slice(0, 400),
        preferSubtitles: true,
        allowAudioFallback: true,
        preferAccuracy: item.plataforma !== 'youtube',
      }),
      env.transcricao.totalChatMs,
      'A transcrição deste vídeo demorou demais.'
    );
    transcricao = String(resultado?.text || '').trim();
  } catch (err) {
    console.info(`[feed-sugerido] transcrição falhou ${item.url}: ${err.message}`);
    if (legenda.length < 80) throw new Error(`Não consegui ouvir o vídeo: ${err.message}`);
  }

  if (transcricao.length < 60 && legenda.length < 80) {
    await atualizarItem(item.id, {
      status: 'ignorado',
      etapa: null,
      erro: 'O vídeo não tem fala nem legenda suficientes para uma matéria.',
    });
    return false;
  }

  // 3) Matéria-rascunho com capa, ligada à página escolhida.
  await atualizarItem(item.id, { status: 'escrevendo', etapa: 'Escrevendo a matéria…' });
  const rotulo = rotuloDoVideo(item.plataforma);
  const perfil = autor ? `${String(autor).startsWith('@') || /\s/.test(autor) ? autor : `@${autor}`}` : null;
  const informacoes = [
    `Fonte: ${rotulo}${perfil ? ` publicado por ${perfil}` : ''}.`,
    `Link do vídeo: ${item.url}`,
    item.titulo ? `Título do vídeo: ${item.titulo}` : null,
    legenda ? `Legenda da publicação:\n${legenda.slice(0, 3000)}` : null,
    transcricao ? `Transcrição do áudio do vídeo:\n${transcricao.slice(0, 9000)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { gerarMateriaManual } = require('./materiaIaService');
  const resultado = await gerarMateriaManual({
    userId: job.user_id,
    informacoes,
    angulo:
      'Matéria jornalística a partir do que é dito no vídeo. Use só os fatos da transcrição e da legenda; não invente nomes, números ou datas.',
    tom: opcoes.tom || 'natural',
    facebookPageId: job.facebook_page_id || null,
    imagemUrl: thumbnail && /^https?:\/\//i.test(thumbnail) ? thumbnail : null,
    creditoImagem: `Reprodução/${ROTULOS[item.plataforma]}${perfil ? ` ${perfil}` : ''}`,
    pesquisarWeb: Boolean(opcoes.pesquisarWeb),
    palavrasChave: opcoes.tema || null,
    fonteBase: {
      veiculo: `${ROTULOS[item.plataforma]}${perfil ? ` (${perfil})` : ''}`,
      titulo: item.titulo || legenda.split('\n')[0]?.slice(0, 200) || rotulo,
      url: item.url,
      resumo: (legenda || transcricao).slice(0, 2000),
    },
  });

  const matterId = resultado?.matter?.id || null;
  await atualizarItem(item.id, {
    status: 'pronto',
    etapa: null,
    erro: null,
    matter_id: matterId,
    titulo: corta(item.titulo || resultado?.matter?.titulo, 500),
  });
  return Boolean(matterId);
}

/**
 * No boot: retoma o que ficou na fila e fecha os vídeos que estavam no meio
 * do caminho (repetir poderia duplicar a matéria).
 */
async function retomarAposReinicio() {
  let jobs = [];
  try {
    jobs = await db(JOBS).whereIn('status', ATIVOS).orderBy('id', 'asc');
  } catch (err) {
    if (/doesn't exist|no such table/i.test(String(err.message))) return;
    throw err;
  }
  for (const job of jobs) {
    await db(ITENS)
      .where({ job_id: job.id })
      .whereIn('status', ['lendo', 'transcrevendo', 'escrevendo'])
      .update({ status: 'erro', etapa: null, erro: 'Interrompido pelo reinício do servidor.', updated_at: db.fn.now() });
    enfileirar(job.id);
  }
  if (jobs.length) console.info(`[feed-sugerido] ${jobs.length} coleta(s) retomada(s) após reinício`);
}

module.exports = {
  criarJob,
  obterJob,
  listarJobs,
  cancelarJob,
  retomarAposReinicio,
};
