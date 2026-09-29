const crypto = require('crypto');
const db = require('../config/db');

/**
 * Piloto automático do Furos do dia.
 *
 * Com "Automatizar" ligado, sem o editor escolher nada:
 *   1. a cada 5 min varre as fontes (nichos + Notícias/YouTube/Instagram/Facebook);
 *   2. a IA avalia as pautas novas e só as melhores entram na fila;
 *   3. escreve a matéria (notícia pelo gerador de furos; vídeo/post pelo chat);
 *   4. gera a imagem com IA (ChatGPT), no máximo 2 ao mesmo tempo no servidor;
 *   5. publica na página a cada N minutos (intervalo do editor).
 *
 * As etapas andam em paralelo: enquanto uma imagem é gerada (a parte lenta),
 * a próxima matéria já está sendo escrita. Nada é publicado sem imagem.
 */

const CONFIG = 'furos_autopilot';
const ITENS = 'furos_autopilot_itens';

const TICK_MS = 30_000;
const SCAN_MS = 5 * 60_000;
/** Limite de gerações de imagem simultâneas no servidor (conta do ChatGPT). */
const MAX_IMAGENS = 2;
/** Matérias escritas à frente da publicação (escritas + em imagem + prontas). */
const BUFFER_ALVO = 3;
const MAX_FILA = 10;
const NOTA_MINIMA_IA = 35;
const TENTATIVAS_IMAGEM = 2;
const LIMITE_ESCRITA_MS = 15 * 60_000;
const FILA_VELHA_MS = 8 * 3_600_000;
const PRONTA_VELHA_MS = 24 * 3_600_000;
const INTERVALOS = [5, 10, 15, 20, 30, 60];
const EM_ANDAMENTO = ['escrevendo', 'aguardando_imagem', 'gerando_imagem', 'pronta'];

const escaneando = new Set();
const escrevendo = new Set();
const publicando = new Set();
let imagensAtivas = 0;
let tickRodando = false;
let timer = null;

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

function comLimite(promise, ms, mensagem) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(mensagem)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** Meia-noite de Brasília (UTC-3), para o limite diário. */
function inicioDoDia() {
  const br = new Date(Date.now() - 3 * 3_600_000);
  br.setUTCHours(0, 0, 0, 0);
  return new Date(br.getTime() + 3 * 3_600_000);
}

/** Mesma pauta vinda de novo (outra varredura, outro canal) tem a mesma chave. */
function chaveDaPauta(pauta) {
  let base = String(pauta.externalId ? `${pauta.canal}:${pauta.externalId}` : pauta.url || '').trim();
  if (!pauta.externalId) {
    try {
      const u = new URL(base);
      if (!/news\.google\.com/i.test(u.host)) u.search = '';
      u.hash = '';
      base = u.toString().replace(/\/$/, '').toLowerCase();
    } catch {
      base = base.toLowerCase();
    }
  }
  return crypto.createHash('sha1').update(base).digest('hex');
}

async function atualizarItem(id, dados) {
  await db(ITENS).where({ id }).update({ ...dados, updated_at: db.fn.now() });
}

async function atualizarConfig(userId, dados) {
  await db(CONFIG).where({ user_id: userId }).update({ ...dados, updated_at: db.fn.now() });
}

// -------------------------------------------------------------- configuração

function formatarConfig(row) {
  return {
    ativo: Boolean(row?.ativo),
    nichos: parseJson(row?.nichos, ['auto']),
    canais: parseJson(row?.canais, ['noticias', 'youtube', 'instagram', 'facebook']),
    horas: Number(row?.horas) || 24,
    intervalo_minutos: Number(row?.intervalo_minutos) || 10,
    limite_dia: Number(row?.limite_dia) || 40,
    facebook_page_id: row?.facebook_page_id || null,
    modelo: row?.modelo || null,
    foto_original_se_falhar: row ? Boolean(row.foto_original_se_falhar) : true,
    ultimo_scan_at: row?.ultimo_scan_at || null,
    proxima_postagem_at: row?.proxima_postagem_at || null,
    ultimo_erro: row?.ultimo_erro || null,
  };
}

async function salvarConfig(userId, entrada = {}) {
  const furosService = require('./furosService');
  const idsNichos = new Set(['auto', ...furosService.NICHOS.map((n) => n.id)]);
  const nichos = [...new Set((Array.isArray(entrada.nichos) ? entrada.nichos : []).map(String))]
    .filter((n) => idsNichos.has(n))
    .slice(0, 4);
  const canais = [...new Set((Array.isArray(entrada.canais) ? entrada.canais : []).map(String))]
    .filter((c) => furosService.CANAIS.includes(c));
  const intervalo = Number(entrada.intervalo_minutos);
  if (!INTERVALOS.includes(intervalo)) throw erro(400, `Escolha um intervalo de ${INTERVALOS.join(', ')} minutos.`);
  const limiteDia = Math.round(Number(entrada.limite_dia) || 40);
  if (limiteDia < 1 || limiteDia > 200) throw erro(400, 'O limite por dia deve ficar entre 1 e 200 publicações.');
  const horas = [12, 24, 48].includes(Number(entrada.horas)) ? Number(entrada.horas) : 24;

  const { resolvePageForUser, defaultPageForUser } = require('./facebookPageResolver');
  const page = entrada.facebook_page_id
    ? await resolvePageForUser(userId, entrada.facebook_page_id)
    : await defaultPageForUser(userId);
  const ativo = Boolean(entrada.ativo);
  if (ativo && !page) throw erro(400, 'Escolha a página do Facebook onde o piloto vai publicar (ou defina uma padrão em /paginas).');

  const atual = await db(CONFIG).where({ user_id: userId }).first();
  const dados = {
    ativo,
    nichos: JSON.stringify(nichos.length ? nichos : ['auto']),
    canais: JSON.stringify(canais.length ? canais : furosService.CANAIS),
    horas,
    intervalo_minutos: intervalo,
    limite_dia: limiteDia,
    facebook_page_id: page?.id || null,
    modelo: corta(entrada.modelo, 120),
    foto_original_se_falhar: entrada.foto_original_se_falhar !== false,
    ultimo_erro: null,
  };
  // Ao ligar: varre já e publica a primeira assim que ficar pronta.
  if (ativo && !atual?.ativo) {
    dados.ultimo_scan_at = null;
    dados.proxima_postagem_at = new Date();
  }
  if (atual) await atualizarConfig(userId, dados);
  else await db(CONFIG).insert({ user_id: userId, ...dados });
  if (ativo) setImmediate(() => void tick());
  return statusPainel(userId);
}

async function statusPainel(userId) {
  const row = await db(CONFIG).where({ user_id: userId }).first();
  const config = formatarConfig(row);
  let contagens = {};
  let itens = [];
  let publicadasHoje = 0;
  try {
    const linhas = await db(ITENS)
      .where({ user_id: userId })
      .whereIn('status', ['na_fila', ...EM_ANDAMENTO, 'publicando'])
      .groupBy('status')
      .select('status')
      .count({ n: '*' });
    contagens = Object.fromEntries(linhas.map((l) => [l.status, Number(l.n)]));
    const hoje = await db(ITENS)
      .where({ user_id: userId, status: 'publicada' })
      .where('publicado_at', '>=', inicioDoDia())
      .count({ n: '*' })
      .first();
    publicadasHoje = Number(hoje?.n) || 0;
    itens = await db(`${ITENS} as i`)
      .leftJoin('ai_matters as m', 'm.id', 'i.matter_id')
      .where('i.user_id', userId)
      .whereNot('i.status', 'descartada')
      .orderBy('i.updated_at', 'desc')
      .limit(30)
      .select(
        'i.id', 'i.canal', 'i.titulo', 'i.url', 'i.status', 'i.nota_ia', 'i.score', 'i.motivo',
        'i.erro', 'i.matter_id', 'i.imagem_ia', 'i.publicado_at', 'i.updated_at',
        'm.titulo as materia_titulo', 'm.imagem_url as materia_imagem'
      );
  } catch (err) {
    if (!/doesn't exist|no such table/i.test(String(err.message))) throw err;
  }
  const proximoScan = config.ultimo_scan_at ? new Date(new Date(config.ultimo_scan_at).getTime() + SCAN_MS) : null;
  return {
    config,
    contagens,
    publicadasHoje,
    proximoScan,
    escaneandoAgora: escaneando.has(Number(userId)),
    maxImagens: MAX_IMAGENS,
    itens,
  };
}

async function escanearAgora(userId) {
  const row = await db(CONFIG).where({ user_id: userId }).first();
  if (!row) throw erro(400, 'Salve a configuração do piloto automático antes.');
  void escanear(row, { forcar: true });
  return statusPainel(userId);
}

async function descartarItem(userId, itemId) {
  const item = await db(ITENS).where({ id: itemId, user_id: userId }).first();
  if (!item) throw erro(404, 'Pauta não encontrada.');
  if (!['na_fila', 'aguardando_imagem', 'pronta', 'erro'].includes(item.status)) {
    throw erro(409, 'Esta pauta já está sendo processada ou foi publicada.');
  }
  await atualizarItem(item.id, { status: 'descartada', erro: 'Retirada da fila pelo editor.' });
  return statusPainel(userId);
}

// ------------------------------------------------------------------ varredura

/** Matérias da página que engajaram (ou, sem histórico, as últimas publicadas). */
async function basesDoPublico(userId, facebookPageId) {
  const AiMatters = require('../models/AiMatters');
  let bases = [];
  try {
    let virais = await AiMatters.findViralizadasDaConta(userId, { limit: 40 });
    if (facebookPageId) virais = virais.filter((m) => Number(m.facebook_page_id) === Number(facebookPageId));
    bases = virais
      .map((m) => ({
        titulo: m.titulo,
        likes: Number(m.pub_fb_likes) || 0,
        comments: Number(m.pub_fb_comments) || 0,
        shares: Number(m.pub_fb_shares) || 0,
      }))
      .sort((a, b) => b.likes + b.comments * 3 + b.shares * 5 - (a.likes + a.comments * 3 + a.shares * 5))
      .slice(0, 20);
  } catch (err) {
    console.warn('[furos-auto] bases virais:', err.message);
  }
  if (bases.length) return bases;
  const recentes = await db('ai_matters')
    .where({ user_id: userId, status: 'publicado' })
    .orderBy('updated_at', 'desc')
    .limit(20)
    .select('titulo');
  return recentes.filter((r) => r.titulo).map((r) => ({ titulo: r.titulo }));
}

/**
 * A IA dá potencial (chance de engajar) e afinidade (com o que já funciona
 * na página). Sem IA disponível, vale só a nota do Furos.
 */
async function avaliarComIa(userId, facebookPageId, candidatos) {
  try {
    const bases = await basesDoPublico(userId, facebookPageId);
    if (!bases.length) return null;
    const avaliacoes = await require('./deepseekService').ranquearPautasParaPublico({
      bases,
      pautas: candidatos.map((c) => ({ titulo: c.titulo, resumo: c.resumo, veiculo: c.veiculo })),
    });
    if (!avaliacoes.length) return null;
    const porId = new Map(avaliacoes.map((a) => [a.id, a]));
    return candidatos.map((_, i) => porId.get(`p${i + 1}`) || null);
  } catch (err) {
    console.warn('[furos-auto] avaliação da IA:', err.message);
    return null;
  }
}

async function escanear(row, { forcar = false } = {}) {
  const userId = Number(row.user_id);
  if (escaneando.has(userId)) return;
  escaneando.add(userId);
  try {
    await atualizarConfig(userId, { ultimo_scan_at: new Date() });
    const naFila = await db(ITENS).where({ user_id: userId, status: 'na_fila' }).count({ n: '*' }).first();
    const vagas = MAX_FILA - (Number(naFila?.n) || 0);
    if (vagas <= 0 && !forcar) return;

    const config = formatarConfig(row);
    const resultado = await require('./furosService').buscarFuros({
      userId,
      nichos: config.nichos,
      horas: config.horas,
      limite: 25,
      canais: config.canais,
    });

    // Só o que nunca foi avaliado.
    const comChave = (resultado.furos || []).map((f) => ({ ...f, chave: chaveDaPauta(f) }));
    const conhecidas = new Set(
      comChave.length
        ? (await db(ITENS).where({ user_id: userId }).whereIn('chave', comChave.map((f) => f.chave)).select('chave')).map((r) => r.chave)
        : []
    );
    let novos = comChave.filter((f) => !conhecidas.has(f.chave));

    // Assunto já publicado pela conta (mesmo que por outro veículo) fica de fora.
    // (A comparação corta o link no "?": "watch?v=ID" viraria o mesmo link para
    // todo vídeo, então o YouTube vai pelo endereço curto.)
    const materiaIaService = require('./materiaIaService');
    const paraComparar = novos.map((f) => ({
      titulo: f.titulo,
      resumo: f.resumo,
      url: f.canal === 'youtube' && f.externalId ? `https://youtu.be/${f.externalId}` : f.url,
    }));
    const marcados = await materiaIaService
      .marcarJaPublicados(userId, config.facebook_page_id, paraComparar)
      .catch(() => paraComparar);
    novos = novos.filter((_, i) => !marcados[i]?.jaPublicado);

    // Mesmo fato de outro veículo que já está no caminho (últimas 48h).
    const { titulosSimilares } = require('./newsResearch');
    const recentes = (await db(ITENS)
      .where({ user_id: userId })
      .whereNot('status', 'descartada')
      .where('created_at', '>=', new Date(Date.now() - 48 * 3_600_000))
      .select('titulo')).map((r) => r.titulo).filter(Boolean);
    const aceitosAgora = [];
    novos = novos.filter((f) => {
      const repetido = [...recentes, ...aceitosAgora].some((t) => titulosSimilares(t, f.titulo));
      if (!repetido) aceitosAgora.push(f.titulo);
      return !repetido;
    });
    if (!novos.length) return;

    const avaliacoes = await avaliarComIa(userId, config.facebook_page_id, novos);
    const avaliados = novos.map((f, i) => {
      const a = avaliacoes?.[i];
      const nota = a
        ? Math.round(0.35 * f.score + 0.45 * a.potencial + 0.2 * a.afinidade)
        : f.score;
      const aprovado = a ? a.potencial >= NOTA_MINIMA_IA : f.score >= 20;
      return { furo: f, nota, aprovado, motivo: a?.motivo || (f.motivos || []).join(', ') };
    });

    avaliados.sort((a, b) => b.nota - a.nota);
    let entram = 0;
    for (const { furo, nota, aprovado, motivo } of avaliados) {
      const entra = aprovado && entram < Math.max(vagas, forcar ? 3 : 0);
      if (aprovado && !entra) continue; // boa, mas a fila está cheia: reavalia depois
      if (entra) entram += 1;
      await db(ITENS)
        .insert({
          user_id: userId,
          chave: furo.chave,
          canal: String(furo.canal || 'noticias').slice(0, 16),
          titulo: corta(furo.titulo, 500),
          url: String(furo.url).slice(0, 1000),
          pauta: JSON.stringify({ ...furo, chave: undefined }),
          score: Math.max(0, Math.round(Number(furo.score) || 0)),
          nota_ia: Math.max(0, Math.min(100, nota)),
          motivo: corta(motivo, 255),
          status: entra ? 'na_fila' : 'descartada',
          erro: entra ? null : 'A IA não recomendou esta pauta.',
        })
        .onConflict(['user_id', 'chave'])
        .ignore();
    }
    console.info(`[furos-auto] user ${userId}: ${novos.length} pautas novas, ${entram} na fila`);
  } catch (err) {
    console.warn(`[furos-auto] varredura user ${userId}:`, err.message);
    await atualizarConfig(userId, { ultimo_erro: corta(`Varredura: ${err.message}`, 500) }).catch(() => {});
  } finally {
    escaneando.delete(userId);
  }
}

// ------------------------------------------------------------------- escrita

async function escreverMateria(item, row) {
  const pauta = parseJson(item.pauta, {});
  const userId = Number(item.user_id);
  const pageId = row.facebook_page_id || null;
  const redeSocial = ['youtube', 'instagram', 'facebook'].includes(item.canal);

  if (!redeSocial) {
    const r = await comLimite(
      require('./furosService').gerarFuro({ userId, pauta, facebookPageId: pageId }),
      LIMITE_ESCRITA_MS,
      'a escrita passou de 15 min'
    );
    return r.matterId;
  }

  let modelo = null;
  if (require('./deepseekService').usarTokenFree('conversa')) {
    modelo = await require('./materiaModelosService').resolverModelo(row.modelo);
  }
  const { escreverPeloChat } = require('./materiaPorChat');
  const { matterId } = await comLimite(
    escreverPeloChat(
      { chatService: require('./materiaChatService'), comModelo: require('./tokenFreeGatewayService').comModelo },
      { userId, url: item.url, facebookPageId: pageId, imagemUrl: pauta.imagem, modelo }
    ),
    LIMITE_ESCRITA_MS,
    'a escrita passou de 15 min'
  );
  if (pauta.bibliotecaPostId && matterId) {
    await require('../models/BibliotecaPosts')
      .update(Number(pauta.bibliotecaPostId), { status: 'rascunho', matter_id: matterId })
      .catch(() => {});
  }
  return matterId;
}

/** Escreve a próxima da fila enquanto houver espaço à frente da publicação. */
async function avancarEscrita(row) {
  const userId = Number(row.user_id);
  if (escrevendo.has(userId)) return;
  const noCaminho = await db(ITENS)
    .where({ user_id: userId })
    .whereIn('status', EM_ANDAMENTO)
    .count({ n: '*' })
    .first();
  if ((Number(noCaminho?.n) || 0) >= BUFFER_ALVO) return;

  const item = await db(ITENS)
    .where({ user_id: userId, status: 'na_fila' })
    .orderByRaw('COALESCE(nota_ia, score) DESC, id ASC')
    .first();
  if (!item) return;

  escrevendo.add(userId);
  try {
    await atualizarItem(item.id, { status: 'escrevendo', erro: null });
    const matterId = await escreverMateria(item, row);
    if (!matterId) throw new Error('a matéria não foi salva');
    // Publicação automática é sempre foto (imagem obrigatória) na página do piloto.
    await require('../models/AiMatters').update(matterId, {
      tipo_publicacao: 'foto',
      ...(row.facebook_page_id ? { facebook_page_id: row.facebook_page_id } : {}),
    });
    await atualizarItem(item.id, { status: 'aguardando_imagem', matter_id: matterId });
    setImmediate(() => void preencherImagens());
  } catch (err) {
    console.warn(`[furos-auto] escrever item ${item.id}:`, err.message);
    await atualizarItem(item.id, { status: 'erro', erro: corta(`Escrita: ${err.message}`, 500) });
  } finally {
    escrevendo.delete(userId);
  }
}

// -------------------------------------------------------------------- imagem

async function gerarImagem(item, row) {
  const pauta = parseJson(item.pauta, {});
  const tentativa = (Number(item.tentativas) || 0) + 1;
  try {
    await require('./materiaPorChat').aplicarCapaChatgpt({
      userId: Number(item.user_id),
      matterId: item.matter_id,
      thumbnail: pauta.imagem,
      permitirSimbolica: true,
    });
    await atualizarItem(item.id, { status: 'pronta', imagem_ia: true, tentativas: tentativa, erro: null });
  } catch (err) {
    console.warn(`[furos-auto] imagem item ${item.id} (tentativa ${tentativa}):`, err.message);
    if (tentativa < TENTATIVAS_IMAGEM) {
      await atualizarItem(item.id, { status: 'aguardando_imagem', tentativas: tentativa, erro: corta(`Imagem: ${err.message}`, 500) });
      return;
    }
    const matter = await require('../models/AiMatters').findById(item.matter_id);
    const temArte = Boolean(matter?.imagem_path || matter?.imagem_url);
    if (row?.foto_original_se_falhar && temArte) {
      await atualizarItem(item.id, {
        status: 'pronta',
        imagem_ia: false,
        tentativas: tentativa,
        erro: corta(`Imagem da IA falhou (${err.message}); vai com a foto original.`, 500),
      });
    } else {
      await atualizarItem(item.id, {
        status: 'erro',
        tentativas: tentativa,
        erro: corta(`Sem imagem: ${err.message}. Não publicada.`, 500),
      });
    }
  }
}

let preenchendo = false;
let pedirDeNovo = false;

/**
 * Ocupa as vagas de geração de imagem (no máximo MAX_IMAGENS no servidor).
 * Uma chamada por vez: duas em paralelo poderiam passar do limite.
 */
async function preencherImagens() {
  if (preenchendo) {
    pedirDeNovo = true;
    return;
  }
  preenchendo = true;
  try {
    await ocuparVagasDeImagem();
  } finally {
    preenchendo = false;
    if (pedirDeNovo) {
      pedirDeNovo = false;
      setImmediate(() => void preencherImagens());
    }
  }
}

async function ocuparVagasDeImagem() {
  while (imagensAtivas < MAX_IMAGENS) {
    const item = await db(`${ITENS} as i`)
      .join(`${CONFIG} as c`, 'c.user_id', 'i.user_id')
      .where('c.ativo', true)
      .where('i.status', 'aguardando_imagem')
      .orderByRaw('COALESCE(i.nota_ia, i.score) DESC, i.id ASC')
      .first('i.*', 'c.foto_original_se_falhar');
    if (!item) return;
    // Reserva atômica: outra volta do tick pode ter pego o mesmo item.
    const reservado = await db(ITENS)
      .where({ id: item.id, status: 'aguardando_imagem' })
      .update({ status: 'gerando_imagem', updated_at: db.fn.now() });
    if (!reservado) continue;
    imagensAtivas += 1;
    gerarImagem(item, { foto_original_se_falhar: item.foto_original_se_falhar })
      .catch((err) => console.warn('[furos-auto] imagem:', err.message))
      .finally(() => {
        imagensAtivas -= 1;
        setImmediate(() => void preencherImagens());
      });
  }
}

// ---------------------------------------------------------------- publicação

const JANELA_DUPLICATA_MS = 72 * 3_600_000;

function tituloLimpo(texto) {
  return String(texto || '').replace(/\[\[|\]\]|\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function linkComparavel(url) {
  const texto = String(url || '').trim().toLowerCase().split('#')[0].replace(/\/$/, '');
  // No YouTube o vídeo está no "?v="; nos demais a query é só rastreio.
  return /youtube\.com\/watch/.test(texto) ? texto : texto.split('?')[0];
}

/**
 * Última barreira antes de postar: devolve o motivo para NÃO publicar
 * (mesma matéria ou mesmo assunto já publicado nas últimas 72h — pelo
 * piloto, à mão, pela Biblioteca ou pelo Feed) ou null.
 * A checagem da publicação do sistema só avisa no log; aqui ela bloqueia.
 */
async function motivoDeDuplicata(userId, item, matter) {
  if (String(matter.status) === 'publicado' || matter.publication_id) {
    return `a matéria #${matter.id} já foi publicada`;
  }
  const mesmaMateria = await db(ITENS)
    .where({ user_id: userId, matter_id: item.matter_id, status: 'publicada' })
    .whereNot('id', item.id)
    .first('id');
  if (mesmaMateria) return `a matéria #${matter.id} já foi publicada pelo piloto`;

  const { titulosParecidos, mesmoAssuntoNoticia } = require('./editorialGuidelinesFb');
  const titulo = tituloLimpo(matter.titulo);
  const parecido = (outro) => {
    const t = tituloLimpo(outro);
    return Boolean(titulo && t && (mesmoAssuntoNoticia(titulo, t) || titulosParecidos(titulo, t)));
  };
  const desde = new Date(Date.now() - JANELA_DUPLICATA_MS);

  const doPiloto = await db(`${ITENS} as i`)
    .leftJoin('ai_matters as m', 'm.id', 'i.matter_id')
    .where('i.user_id', userId)
    .where('i.status', 'publicada')
    .where('i.publicado_at', '>=', desde)
    .select('i.titulo', 'm.titulo as materia_titulo');
  const repetidoPiloto = doPiloto.find((p) => parecido(p.materia_titulo) || parecido(p.titulo));
  if (repetidoPiloto) return `mesmo assunto de “${tituloLimpo(repetidoPiloto.materia_titulo || repetidoPiloto.titulo)}”, já publicado pelo piloto`;

  const publicadas = await db('ai_matters')
    .where({ user_id: userId, status: 'publicado' })
    .whereNot('id', matter.id)
    .where('updated_at', '>=', desde)
    .select('id', 'titulo', 'fonte_url');
  const link = linkComparavel(matter.fonte_url);
  const repetida = publicadas.find((m) => (link && linkComparavel(m.fonte_url) === link) || parecido(m.titulo));
  if (repetida) return `mesmo assunto da matéria #${repetida.id} (“${tituloLimpo(repetida.titulo)}”), já publicada`;

  const posts = await require('../models/Publications').historyForDedupe(userId, 300).catch(() => []);
  const repetidoNaPagina = posts
    .filter((p) => new Date(p.created_at).getTime() >= desde.getTime())
    .map((p) => String(p.texto || p.legenda_sugerida || '').split(/\n+/).find((l) => l.trim()) || '')
    .find((primeiraLinha) => parecido(primeiraLinha.slice(0, 300)));
  if (repetidoNaPagina) return `a página já tem um post sobre isso: “${tituloLimpo(repetidoNaPagina).slice(0, 120)}”`;
  return null;
}

async function tentarPublicar(row) {
  const userId = Number(row.user_id);
  if (publicando.has(userId)) return;
  const proxima = row.proxima_postagem_at ? new Date(row.proxima_postagem_at).getTime() : 0;
  if (proxima > Date.now()) return;

  const hoje = await db(ITENS)
    .where({ user_id: userId, status: 'publicada' })
    .where('publicado_at', '>=', inicioDoDia())
    .count({ n: '*' })
    .first();
  if ((Number(hoje?.n) || 0) >= Number(row.limite_dia || 40)) return;

  const item = await db(ITENS)
    .where({ user_id: userId, status: 'pronta' })
    .orderByRaw('COALESCE(nota_ia, score) DESC, id ASC')
    .first();
  if (!item) return;

  publicando.add(userId);
  const intervaloMs = (Number(row.intervalo_minutos) || 10) * 60_000;
  try {
    const reservado = await db(ITENS).where({ id: item.id, status: 'pronta' })
      .update({ status: 'publicando', updated_at: db.fn.now() });
    if (!reservado) return;
    const matter = await require('../models/AiMatters').findById(item.matter_id);
    if (!matter) throw new Error('a matéria foi apagada');
    if (!matter.imagem_path && !matter.imagem_url) throw new Error('a matéria está sem imagem');
    const duplicata = await motivoDeDuplicata(userId, item, matter);
    if (duplicata) {
      // Não gasta o intervalo: a próxima pronta sai na volta seguinte.
      console.info(`[furos-auto] user ${userId}: item ${item.id} não publicado (duplicata): ${duplicata}`);
      await atualizarItem(item.id, { status: 'descartada', erro: corta(`Não publicada para não duplicar: ${duplicata}.`, 500) });
      return;
    }
    await require('./materiaIaService').publicarMateria(userId, item.matter_id);
    await atualizarItem(item.id, { status: 'publicada', publicado_at: new Date(), erro: null });
    await atualizarConfig(userId, { proxima_postagem_at: new Date(Date.now() + intervaloMs), ultimo_erro: null });
    console.info(`[furos-auto] user ${userId}: publicada matéria ${item.matter_id}`);
  } catch (err) {
    console.warn(`[furos-auto] publicar item ${item.id}:`, err.message);
    await atualizarItem(item.id, { status: 'erro', erro: corta(`Publicação: ${err.message}`, 500) });
    // Tenta a próxima pronta daqui a 1 min, sem esperar o intervalo inteiro.
    await atualizarConfig(userId, {
      proxima_postagem_at: new Date(Date.now() + 60_000),
      ultimo_erro: corta(`Publicação: ${err.message}`, 500),
    });
  } finally {
    publicando.delete(userId);
  }
}

// ---------------------------------------------------------------------- loop

async function limparVelhas(userId) {
  const agora = Date.now();
  await db(ITENS)
    .where({ user_id: userId, status: 'na_fila' })
    .where('created_at', '<', new Date(agora - FILA_VELHA_MS))
    .update({ status: 'descartada', erro: 'A pauta envelheceu na fila.', updated_at: db.fn.now() });
  await db(ITENS)
    .where({ user_id: userId, status: 'pronta' })
    .where('updated_at', '<', new Date(agora - PRONTA_VELHA_MS))
    .update({ status: 'descartada', erro: 'Pronta há mais de 24h: ficou velha para publicar.', updated_at: db.fn.now() });
}

async function tick() {
  if (tickRodando) return;
  tickRodando = true;
  try {
    let configs = [];
    try {
      configs = await db(CONFIG).where({ ativo: true });
    } catch (err) {
      if (/doesn't exist|no such table/i.test(String(err.message))) return;
      throw err;
    }
    for (const row of configs) {
      try {
        await limparVelhas(row.user_id);
        const ultimo = row.ultimo_scan_at ? new Date(row.ultimo_scan_at).getTime() : 0;
        if (Date.now() - ultimo >= SCAN_MS) void escanear(row);
        void avancarEscrita(row).catch((err) => console.warn('[furos-auto] escrita:', err.message));
        await tentarPublicar(row);
      } catch (err) {
        console.warn(`[furos-auto] user ${row.user_id}:`, err.message);
      }
    }
    await preencherImagens();
  } catch (err) {
    console.error('[furos-auto] tick:', err.message);
  } finally {
    tickRodando = false;
  }
}

/**
 * No boot: o que estava no meio volta para a etapa anterior. Publicação
 * interrompida vira erro (repetir poderia postar duas vezes).
 */
async function recuperar() {
  try {
    await db(ITENS).where({ status: 'escrevendo' })
      .update({ status: 'erro', erro: 'Interrompida pelo reinício do servidor durante a escrita.', updated_at: db.fn.now() });
    await db(ITENS).where({ status: 'gerando_imagem' })
      .update({ status: 'aguardando_imagem', updated_at: db.fn.now() });
    await db(ITENS).where({ status: 'publicando' })
      .update({ status: 'erro', erro: 'Reinício durante a publicação: confira na página se saiu.', updated_at: db.fn.now() });
  } catch (err) {
    if (!/doesn't exist|no such table/i.test(String(err.message))) throw err;
  }
}

function iniciar() {
  if (timer) return;
  recuperar()
    .catch((err) => console.error('[furos-auto] recuperar:', err.message))
    .finally(() => {
      timer = setInterval(() => void tick(), TICK_MS);
      setTimeout(() => void tick(), 20_000);
    });
}

module.exports = {
  INTERVALOS,
  MAX_IMAGENS,
  salvarConfig,
  statusPainel,
  escanearAgora,
  descartarItem,
  iniciar,
  tick,
  // exportados para testes
  chaveDaPauta,
  preencherImagens,
};
