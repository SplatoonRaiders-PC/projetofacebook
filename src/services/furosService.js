/**
 * Furos do dia: acha no Google News as notícias mais quentes de um nicho,
 * ordena pelo potencial de repercussão e gera matérias próprias (modo furo),
 * já com imagem e crédito, prontas para revisar e postar no Facebook.
 *
 * Reaproveita o radar de pautas (busca + agrupamento por assunto + pautas já
 * usadas) e o gerador de matérias por link. Aqui ficam só os nichos, a
 * pontuação e a orquestração.
 */

const NICHOS = Object.freeze([
  {
    id: 'politica',
    rotulo: 'Política',
    consultas: ['Congresso Nacional votação', 'STF decisão ministro'],
    palavras: ['politica', 'stf', 'congresso', 'senado', 'camara', 'deputado', 'senador', 'lula', 'bolsonaro', 'eleicao', 'eleicoes', 'governo', 'ministro'],
  },
  {
    id: 'politica-fe',
    rotulo: 'Política e fé',
    consultas: ['bancada evangélica', 'política evangélicos'],
    palavras: ['bancada evangelica', 'frente parlamentar evangelica', 'evangelicos', 'voto evangelico'],
  },
  {
    id: 'igreja',
    rotulo: 'Igreja',
    consultas: ['igreja evangélica', 'Assembleia de Deus'],
    palavras: ['igreja', 'assembleia de deus', 'universal', 'batista', 'denominacao', 'culto', 'templo'],
  },
  {
    id: 'pastores',
    rotulo: 'Pastores',
    consultas: ['pastor polêmica', 'pastor evangélico'],
    palavras: ['pastor', 'pastora', 'apostolo', 'bispo', 'missionaria', 'lider evangelico'],
  },
  {
    id: 'gospel',
    rotulo: 'Música gospel',
    consultas: ['cantor gospel', 'cantora gospel'],
    palavras: ['gospel', 'cantor', 'cantora', 'louvor', 'musica'],
  },
  {
    id: 'catolicos',
    rotulo: 'Igreja Católica',
    consultas: ['Papa Vaticano', 'Igreja Católica padre'],
    palavras: ['papa', 'vaticano', 'catolica', 'catolico', 'padre', 'cardeal'],
  },
  {
    id: 'israel',
    rotulo: 'Israel e cristãos no mundo',
    consultas: ['Israel guerra', 'cristãos perseguidos'],
    palavras: ['israel', 'jerusalem', 'perseguidos', 'perseguicao', 'cristaos'],
  },
  {
    id: 'policia',
    rotulo: 'Polícia e justiça',
    consultas: ['Polícia Federal operação', 'preso suspeito investigação'],
    palavras: ['policia', 'preso', 'prisao', 'operacao', 'investigacao', 'crime', 'condenado'],
  },
]);

const NICHOS_PADRAO = ['politica-fe', 'igreja', 'pastores'];
const MAX_NICHOS = 4;

/**
 * Palavras que costumam indicar notícia de alta repercussão no feed. Pesam
 * junto com a quantidade de veículos cobrindo o assunto e a atualidade.
 */
const GATILHOS = [
  { rotulo: 'Polêmica', peso: 12, termos: ['polemica', 'polemico', 'critica', 'critico', 'revolta', 'repercute', 'repercussao', 'viraliza', 'viralizou'] },
  { rotulo: 'Denúncia', peso: 14, termos: ['denuncia', 'escandalo', 'acusa', 'acusado', 'acusacao', 'fraude', 'desvio', 'investigado', 'investigacao'] },
  { rotulo: 'Justiça', peso: 12, termos: ['preso', 'prisao', 'condenado', 'condenacao', 'stf', 'pf', 'operacao', 'mandado', 'inquerito', 'cassado', 'cassacao'] },
  { rotulo: 'Tragédia', peso: 10, termos: ['morre', 'morte', 'morto', 'mortos', 'tragedia', 'acidente', 'ataque', 'atentado'] },
  { rotulo: 'Reviravolta', peso: 10, termos: ['revela', 'exclusivo', 'inedito', 'reviravolta', 'rompe', 'renuncia', 'demitido', 'afastado', 'expulso'] },
  { rotulo: 'Disputa', peso: 8, termos: ['briga', 'bate-boca', 'rebate', 'responde', 'ataca', 'confronto', 'embate', 'processa'] },
  { rotulo: 'Urgente', peso: 8, termos: ['urgente', 'agora', 'ultima hora', 'alerta'] },
];

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contemTermo(textoNormalizado, termo) {
  return new RegExp(`(^|\\s)${termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(textoNormalizado);
}

function timestampDoItem(item) {
  const ts = Number(item?.dataTimestamp) || Date.parse(String(item?.data || '')) || 0;
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

/**
 * Nota de 0 a 100 e os motivos em linguagem simples, para o editor entender
 * por que a pauta subiu na lista.
 */
function pontuarBomba(item, agora = Date.now()) {
  const texto = normalizar(`${item?.titulo || ''} ${item?.resumo || ''}`);
  const motivos = [];
  let pontos = 0;

  const veiculos = Math.max(Number(item?.contagemFontes) || 0, (item?.veiculos || []).length, 1);
  pontos += Math.min(veiculos - 1, 6) * 6;
  if (veiculos >= 2) motivos.push(`${veiculos} veículos`);

  if (item?.sinalGoogleNews || item?.emAlta || item?.sinalTrends) {
    pontos += 12;
    motivos.push('Em alta no Google');
  }
  if (item?.sinalRedes || item?.redeSocial) {
    pontos += 6;
    motivos.push('Repercute nas redes');
  }

  for (const gatilho of GATILHOS) {
    if (gatilho.termos.some((termo) => contemTermo(texto, termo))) {
      pontos += gatilho.peso;
      motivos.push(gatilho.rotulo);
    }
  }

  const ts = timestampDoItem(item);
  if (ts) {
    const horas = (agora - ts) / 3_600_000;
    if (horas <= 3) {
      pontos += 14;
      motivos.push('Últimas 3h');
    } else if (horas <= 8) {
      pontos += 9;
    } else if (horas <= 24) {
      pontos += 4;
    }
  }

  return { score: Math.max(0, Math.min(100, Math.round(pontos))), motivos: motivos.slice(0, 4) };
}

/**
 * O Google devolve, para "pastor polêmica", até notícia de celebridade sem
 * pastor nenhum. Pauta que não cita o nicho vai para o fim da fila.
 */
function pertenceAoNicho(item, nicho) {
  if (!nicho) return true;
  const texto = normalizar(`${item?.titulo || ''} ${item?.resumo || ''}`);
  return nicho.palavras.some((palavra) => comecaCom(texto, palavra));
}

/** Palavra do nicho como prefixo: "pastor" também pega "pastores" e "pastora". */
function comecaCom(textoNormalizado, prefixo) {
  return new RegExp(`(^|\\s)${prefixo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(textoNormalizado);
}

function comPrazo(promessa, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promessa).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const EH_LINK_GOOGLE = /news\.google\.com/i;

/**
 * Os links do Google News não redirecionam mais para a matéria. A busca em
 * Python devolve os endereços reais; com as mesmas consultas do nicho, ela
 * vira um índice título → link para casar com as pautas do radar.
 */
async function indiceDeLinksDiretos(consultas, horas) {
  const nr = require('./newsResearch');
  const when = horas <= 24 ? '1d' : '2d';
  const listas = await Promise.all(
    consultas.map((consulta) => comPrazo(nr.buscarGoogleNewsPython(consulta, { when, limit: 20 }), 20_000))
  );
  return listas
    .flat()
    .filter((item) => item?.titulo && /^https?:\/\//i.test(String(item.link || '')) && !EH_LINK_GOOGLE.test(item.link));
}

/**
 * Prefere a matéria do mesmo veículo. Se só achar a notícia em outro site,
 * devolve esse veículo junto: fonte e foto precisam citar a mesma matéria.
 */
async function linkDiretoPeloTitulo(furo, indice) {
  const nr = require('./newsResearch');
  const mesmoVeiculo = (item) => normalizar(item.veiculo) === normalizar(furo.veiculo);
  const escolher = (lista) => {
    const parecidos = (lista || []).filter(
      (item) => !EH_LINK_GOOGLE.test(String(item.link || '')) && nr.titulosSimilares(item.titulo, furo.titulo)
    );
    return parecidos.find(mesmoVeiculo) || parecidos[0] || null;
  };
  const achado = escolher(indice)
    || escolher(await comPrazo(nr.buscarGoogleNewsPython(furo.titulo, { when: '2d', limit: 5 }), 15_000));
  return achado ? { url: achado.link, veiculo: String(achado.veiculo || '').trim() || null } : null;
}

/**
 * Só para as pautas que vão aparecer: troca o link do Google pelo da matéria
 * e lê a og:image. Com prazo curto; sem foto, a pauta continua valendo.
 */
async function completarLinkEImagem(furo, indice) {
  const { extrairMetadadosImagemArtigo } = require('./articleSource');
  const direto = EH_LINK_GOOGLE.test(furo.url)
    ? await comPrazo(linkDiretoPeloTitulo(furo, indice), 18_000)
    : { url: furo.url, veiculo: null };
  if (!direto?.url) return furo;
  const completo = { ...furo, url: direto.url };
  if (direto.veiculo && normalizar(direto.veiculo) !== normalizar(furo.veiculo)) {
    completo.veiculos = [...new Set([direto.veiculo, furo.veiculo, ...(furo.veiculos || [])])].slice(0, 5);
    completo.veiculo = direto.veiculo;
    // A foto encontrada pelo radar era do outro veículo; lê a da matéria nova.
    completo.imagem = null;
  }
  if (!completo.imagem) {
    const meta = await comPrazo(extrairMetadadosImagemArtigo(completo.url), 9_000);
    if (/^https?:\/\//i.test(String(meta?.imagem || ''))) completo.imagem = String(meta.imagem);
  }
  return completo;
}

/** Roda `tarefa` em todos os itens com no máximo `limite` ao mesmo tempo. */
async function emLotes(itens, limite, tarefa) {
  const saida = new Array(itens.length);
  let proximo = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (proximo < itens.length) {
      const atual = proximo;
      proximo += 1;
      saida[atual] = await tarefa(itens[atual]);
    }
  });
  await Promise.all(trabalhadores);
  return saida;
}

/**
 * Reparte as vagas entre os nichos escolhidos, do mais quente para o menos
 * quente em cada um. Sem isso, um nicho movimentado ocupava a lista inteira.
 */
function repartirPorNicho(itens, rotulos, limite) {
  const filas = new Map(rotulos.map((rotulo) => [rotulo, []]));
  const sobra = [];
  for (const item of itens) (filas.get(item.nicho) || sobra).push(item);
  const escolhidos = [];
  while (escolhidos.length < limite && [...filas.values()].some((fila) => fila.length)) {
    for (const fila of filas.values()) {
      if (escolhidos.length >= limite) break;
      if (fila.length) escolhidos.push(fila.shift());
    }
  }
  for (const item of sobra) {
    if (escolhidos.length >= limite) break;
    escolhidos.push(item);
  }
  return escolhidos;
}

function nichosValidos(ids) {
  const conhecidos = new Set(NICHOS.map((n) => n.id));
  return [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => conhecidos.has(id)))]
    .slice(0, MAX_NICHOS);
}

/**
 * "Automático": os nichos que mais aparecem nas matérias recentes da conta.
 * Sem histórico suficiente, usa o foco padrão do produto.
 */
async function escolherNichosAutomaticos(userId) {
  let materias = [];
  try {
    const AiMatters = require('../models/AiMatters');
    materias = await AiMatters.findByUser(userId, 80);
  } catch (err) {
    console.warn('[furos] histórico indisponível:', err.message);
  }

  const contagem = new Map(NICHOS.map((n) => [n.id, 0]));
  for (const materia of materias) {
    const texto = normalizar(`${materia.titulo || ''} ${materia.hashtags || ''}`);
    for (const nicho of NICHOS) {
      if (nicho.palavras.some((palavra) => comecaCom(texto, palavra))) {
        contagem.set(nicho.id, contagem.get(nicho.id) + 1);
      }
    }
  }

  const ordenados = [...contagem.entries()]
    .filter(([, total]) => total >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id);
  return ordenados.length ? ordenados : [...NICHOS_PADRAO];
}

function listarNichos() {
  return NICHOS.map(({ id, rotulo }) => ({ id, rotulo }));
}

/**
 * Busca e ordena. `nichos` vazio ou ['auto'] usa a escolha automática.
 */
async function buscarFuros({ userId, nichos = [], horas = 24, limite = 12 } = {}) {
  const automatico = !nichos.length || nichos.includes('auto');
  const ids = automatico ? await escolherNichosAutomaticos(userId) : nichosValidos(nichos);
  if (!ids.length) {
    const err = new Error('Escolha pelo menos um nicho.');
    err.status = 400;
    throw err;
  }

  const selecionados = NICHOS.filter((n) => ids.includes(n.id));
  const { radarPorTemas } = require('../routes/materiaChatExtras');
  const janela = [12, 24, 48].includes(Number(horas)) ? Number(horas) : 24;
  const [resultado, indiceDireto] = await Promise.all([
    radarPorTemas(
      selecionados.map((n) => ({ rotulo: n.rotulo, consultas: n.consultas })),
      { horas: janela, limite: Math.max(limite * 2, 20), userId }
    ),
    indiceDeLinksDiretos(selecionados.flatMap((n) => n.consultas), janela).catch(() => []),
  ]);

  const agora = Date.now();
  const nichoPorRotulo = new Map(selecionados.map((n) => [n.rotulo, n]));
  const pontuados = (resultado.topicos || [])
    .filter((t) => t && t.titulo && (t.link || t.url))
    .map((t) => {
      const { score, motivos } = pontuarBomba(t, agora);
      return {
        noNicho: pertenceAoNicho(t, nichoPorRotulo.get(t.tema)),
        titulo: String(t.titulo).replace(/\s+/g, ' ').trim().slice(0, 300),
        url: String(t.link || t.url).trim().slice(0, 1000),
        veiculo: String(t.veiculo || t.fonte || 'Web').trim().slice(0, 120),
        veiculos: (t.veiculos || []).slice(0, 5),
        resumo: String(t.resumo || t.trecho || '').replace(/\s+/g, ' ').trim().slice(0, 420),
        imagem: /^https?:\/\//i.test(String(t.imagemFonte || t.imagem || '')) ? String(t.imagemFonte || t.imagem) : null,
        data: t.data || null,
        dataTimestamp: timestampDoItem(t),
        nicho: t.tema || null,
        score,
        motivos,
      };
    })
    .sort((a, b) => b.score - a.score);

  // Pauta que não cita o nicho é ruído do Google; só completa uma lista curta.
  const doNicho = pontuados.filter((p) => p.noNicho);
  const foraDoNicho = pontuados.filter((p) => !p.noNicho);
  const escolhidos = repartirPorNicho(doNicho, selecionados.map((n) => n.rotulo), limite);
  const minimo = Math.min(limite, 5);
  if (escolhidos.length < minimo) escolhidos.push(...foraDoNicho.slice(0, minimo - escolhidos.length));
  escolhidos.sort((a, b) => b.score - a.score);
  for (const item of escolhidos) delete item.noNicho;
  const furos = await emLotes(escolhidos, 4, (furo) => completarLinkEImagem(furo, indiceDireto));

  return {
    nichos: selecionados.map(({ id, rotulo }) => ({ id, rotulo })),
    automatico,
    horas: janela,
    totalAnalisado: Number(resultado.totalAnalisado) || 0,
    totalOcultado: Number(resultado.totalOcultado) || 0,
    furos,
  };
}

/**
 * Uma pauta → um rascunho. O front chama uma por vez para mostrar o
 * progresso e não segurar uma requisição por vários minutos.
 */
async function gerarFuro({ userId, pauta = {}, facebookPageId = null } = {}) {
  const url = String(pauta.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error('Pauta sem link válido.');
    err.status = 400;
    throw err;
  }

  const materiaIaService = require('./materiaIaService');
  // O gerador apura o link (texto, autor e og:image) antes de escrever e
  // mantém a imagem que o radar já encontrou quando a página não expõe outra.
  const topico = {
    link: url,
    titulo: String(pauta.titulo || '').trim().slice(0, 300) || null,
    resumo: String(pauta.resumo || '').trim().slice(0, 1200) || null,
    fonte: String(pauta.veiculo || '').trim().slice(0, 120) || null,
    veiculo: String(pauta.veiculo || '').trim().slice(0, 120) || null,
    imagemFonte: /^https?:\/\//i.test(String(pauta.imagem || '')) ? String(pauta.imagem) : null,
  };

  let pageId = facebookPageId;
  if (!pageId) {
    const { defaultPageIdForUser } = require('./facebookPageResolver');
    pageId = await defaultPageIdForUser(userId).catch(() => null);
  }

  const result = await materiaIaService.gerarCompleto({
    userId,
    topico,
    facebookPageId: pageId || null,
    tipoPublicacao: 'foto',
    status: 'rascunho',
    furoReportagem: true,
    exigirFonteDocumentada: true,
  });

  const matter = result?.matter || null;
  return {
    matterId: matter?.id || null,
    titulo: matter?.titulo || topico.titulo || 'Matéria',
    imagem: matter?.imagem_url || topico.imagemFonte || null,
    redirect: matter?.id ? `/materias-ia/${matter.id}` : '/minhas-materias',
  };
}

module.exports = {
  NICHOS,
  listarNichos,
  escolherNichosAutomaticos,
  pontuarBomba,
  buscarFuros,
  gerarFuro,
};
