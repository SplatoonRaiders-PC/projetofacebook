import { Innertube, Log } from 'youtubei.js';
import fs from 'node:fs';

/**
 * Lista os Shorts que o YouTube sugere para a conta dos cookies.
 *
 * Uso: node youtube-shorts-feed.mjs <quantidade> [videoIdInicial] [tema]
 * O cabeçalho Cookie chega pelo stdin (nunca em argumentos, ps ou logs).
 * Saída: JSON { itens: [{ videoId, titulo }], origem }.
 */

function fail(message) {
  process.stderr.write(`${String(message || 'Falha ao ler os Shorts sugeridos')}\n`);
  process.exit(1);
}

// Avisos do parser (classes novas do YouTube) não interessam aqui.
try {
  Log.setLevel(Log.Level.NONE);
} catch {
  // versão sem Log
}

const quantidade = Math.min(Math.max(Number(process.argv[2]) || 10, 1), 50);
const seedInicial = String(process.argv[3] || '').trim();
const tema = String(process.argv[4] || '').trim().slice(0, 120);
const ID_VALIDO = /^[A-Za-z0-9_-]{11}$/;

const vistos = new Set();
const itens = [];

function adicionar(videoId, titulo = '') {
  const id = String(videoId || '').trim();
  if (!ID_VALIDO.test(id) || vistos.has(id) || id === seedInicial) return;
  vistos.add(id);
  itens.push({ videoId: id, titulo: String(titulo || '').replace(/\s+/g, ' ').trim().slice(0, 300) });
}

/** Percorre a resposta crua procurando os endpoints de Short (reelWatchEndpoint). */
function coletarShortsDoJson(node, profundidade = 0) {
  if (!node || typeof node !== 'object' || profundidade > 60) return;
  if (Array.isArray(node)) {
    for (const item of node) coletarShortsDoJson(item, profundidade + 1);
    return;
  }
  const lockup = node.shortsLockupViewModel;
  if (lockup) {
    const id =
      lockup.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
      String(lockup.entityId || '').replace(/^shorts-shelf-item-/, '');
    const titulo =
      lockup.overlayMetadata?.primaryText?.content ||
      lockup.accessibilityText ||
      '';
    adicionar(id, titulo);
  }
  if (node.reelWatchEndpoint?.videoId) adicionar(node.reelWatchEndpoint.videoId);
  for (const valor of Object.values(node)) {
    if (valor && typeof valor === 'object') coletarShortsDoJson(valor, profundidade + 1);
  }
}

function tokensDeContinuacao(node, saida = [], profundidade = 0) {
  if (!node || typeof node !== 'object' || profundidade > 60) return saida;
  if (Array.isArray(node)) {
    for (const item of node) tokensDeContinuacao(item, saida, profundidade + 1);
    return saida;
  }
  const token = node.continuationCommand?.token || node.nextContinuationData?.continuation;
  if (token) saida.push(String(token));
  for (const valor of Object.values(node)) {
    if (valor && typeof valor === 'object') tokensDeContinuacao(valor, saida, profundidade + 1);
  }
  return saida;
}

/** Sequência "próximos Shorts" a partir de um Short (é o que o app mostra ao rolar). */
async function sequenciaAPartirDe(youtube, videoId) {
  const info = await youtube.getShortsVideoInfo(videoId);
  const lerFeed = (feed) => {
    for (const entrada of Array.isArray(feed) ? feed : []) {
      const id =
        entrada?.payload?.videoId ||
        entrada?.endpoint?.payload?.videoId ||
        entrada?.command?.payload?.videoId ||
        entrada?.video_id ||
        entrada?.videoId;
      adicionar(id);
    }
  };
  lerFeed(info.watch_next_feed);
  let paginas = 0;
  while (itens.length < quantidade && paginas < 6 && typeof info.getWatchNextContinuation === 'function') {
    paginas += 1;
    let proximo;
    try {
      proximo = await info.getWatchNextContinuation();
    } catch {
      break;
    }
    const antes = itens.length;
    lerFeed(Array.isArray(proximo) ? proximo : proximo?.watch_next_feed || proximo?.entries);
    if (itens.length === antes) break;
  }
}

try {
  const cookie = String(fs.readFileSync(0, 'utf8') || '').trim();
  const youtube = await Innertube.create({
    retrieve_player: false,
    cookie: cookie || undefined,
    lang: 'pt',
    location: 'BR',
  });

  let origem = 'home';
  // 1) Home da conta: a prateleira de Shorts já vem personalizada pelos cookies.
  if (!seedInicial) {
    const resposta = await youtube.actions.execute('/browse', { browseId: 'FEwhat_to_watch' });
    coletarShortsDoJson(resposta?.data);
    const tokens = tokensDeContinuacao(resposta?.data);
    for (let i = 0; i < 3 && itens.length < quantidade && tokens.length; i += 1) {
      const mais = await youtube.actions.execute('/browse', { continuation: tokens.shift() });
      coletarShortsDoJson(mais?.data);
      tokens.push(...tokensDeContinuacao(mais?.data));
    }
  }

  // Sem sessão/histórico a home vem vazia: parte de Shorts sobre o tema.
  if (!seedInicial && !itens.length) {
    origem = 'busca';
    const busca = await youtube.actions.execute('/search', {
      query: tema || 'notícias',
      params: 'EgIQCQ%3D%3D', // filtro "Shorts"
    });
    coletarShortsDoJson(busca?.data);
  }

  // 2) "Rolar" o feed de Shorts a partir do link informado ou do 1º Short da home.
  const seed = seedInicial || itens[0]?.videoId;
  if (seed && itens.length < quantidade) {
    origem = seedInicial ? 'sequencia-link' : `${origem}+sequencia`;
    try {
      await sequenciaAPartirDe(youtube, seed);
    } catch (err) {
      if (!itens.length) throw err;
    }
  }

  if (!itens.length) fail('O YouTube não devolveu Shorts sugeridos para esta conta.');
  process.stdout.write(JSON.stringify({ itens: itens.slice(0, quantidade), origem }));
  process.exit(0);
} catch (error) {
  fail(error?.message || error);
}
