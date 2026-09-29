import { Innertube, Log } from 'youtubei.js';
import fs from 'node:fs';

/**
 * Busca vídeos recentes no YouTube para o Furos do dia.
 *
 * Entrada (stdin, JSON): { cookie, consultas: string[], periodo: 'hoje'|'semana', limite }
 * O cookie chega pelo stdin para nunca aparecer em argumentos, ps ou logs.
 * Saída: JSON { itens: [{ videoId, titulo, canal, views, publicado, consulta, curto }] }.
 */

try {
  Log.setLevel(Log.Level.NONE);
} catch {
  // versão sem Log
}

function fail(message) {
  process.stderr.write(`${String(message || 'Falha na busca do YouTube')}\n`);
  process.exit(1);
}

// Filtros da busca (protobuf da própria interface do YouTube):
// "Vídeo" + "Hoje" e "Vídeo" + "Esta semana".
const FILTROS = { hoje: 'EgQIAhAB', semana: 'EgQIAxAB' };

function texto(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return String(node.simpleText);
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
  if (node.content) return String(node.content);
  return '';
}

/** Percorre a resposta crua e devolve os videoRenderer encontrados. */
function renderers(node, saida = [], profundidade = 0) {
  if (!node || typeof node !== 'object' || profundidade > 40) return saida;
  if (Array.isArray(node)) {
    for (const item of node) renderers(item, saida, profundidade + 1);
    return saida;
  }
  if (node.videoRenderer?.videoId) saida.push(node.videoRenderer);
  for (const valor of Object.values(node)) {
    if (valor && typeof valor === 'object') renderers(valor, saida, profundidade + 1);
  }
  return saida;
}

try {
  const entrada = JSON.parse(String(fs.readFileSync(0, 'utf8') || '{}'));
  const consultas = (Array.isArray(entrada.consultas) ? entrada.consultas : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const params = FILTROS[entrada.periodo] || FILTROS.hoje;
  const limite = Math.min(Math.max(Number(entrada.limite) || 8, 1), 20);

  const youtube = await Innertube.create({
    retrieve_player: false,
    cookie: String(entrada.cookie || '').trim() || undefined,
    lang: 'pt',
    location: 'BR',
  });

  const vistos = new Set();
  const itens = [];
  const respostas = await Promise.allSettled(
    consultas.map((query) => youtube.actions.execute('/search', { query, params }).then((r) => ({ query, r })))
  );
  for (const resposta of respostas) {
    if (resposta.status !== 'fulfilled') continue;
    const { query, r } = resposta.value;
    let porConsulta = 0;
    for (const v of renderers(r?.data)) {
      if (porConsulta >= limite) break;
      if (vistos.has(v.videoId)) continue;
      // Ao vivo agora não tem fala fechada para transcrever.
      if (v.badges?.some((b) => /live|ao vivo/i.test(texto(b?.metadataBadgeRenderer?.label)))) continue;
      vistos.add(v.videoId);
      porConsulta += 1;
      itens.push({
        videoId: v.videoId,
        titulo: texto(v.title).replace(/\s+/g, ' ').trim().slice(0, 300),
        canal: texto(v.ownerText || v.longBylineText).trim().slice(0, 120),
        views: texto(v.viewCountText).trim().slice(0, 60),
        publicado: texto(v.publishedTimeText).trim().slice(0, 60),
        duracao: texto(v.lengthText).trim().slice(0, 20),
        curto: /\/shorts\//.test(String(v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '')),
        consulta: query,
      });
    }
  }
  process.stdout.write(JSON.stringify({ itens }));
  process.exit(0);
} catch (error) {
  fail(error?.message || error);
}
