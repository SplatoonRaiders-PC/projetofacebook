const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

/**
 * Coleta os vídeos curtos que cada rede sugere para a conta dos cookies
 * salvos no sistema — o equivalente a abrir o Reels/Shorts e ir rolando.
 *
 * Cada coletor devolve { itens, origem, motivo } e nunca lança erro: uma rede
 * falhar não pode impedir as outras de gerar matérias.
 *
 * Item: { plataforma, externalId, url, titulo, legenda, autor, thumbnail, mediaUrl }
 */

const YOUTUBE_SHORTS_SCRIPT = path.resolve(__dirname, '../../scripts/youtube-shorts-feed.mjs');
const USER_AGENT =
  process.env.SOCIAL_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pausa com variação: pedidos em ritmo fixo parecem robô para a Meta. */
function pausaHumana(minMs = 1200, maxMs = 2800) {
  return esperar(minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs)));
}

function textoCurto(valor, max = 300) {
  return String(valor || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------- Instagram

function shortcodeDoInstagram(url) {
  const m = String(url || '').match(/instagram\.com\/(?:[^/?#]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,40})/i);
  return m ? m[1] : null;
}

function itemDoMediaInstagram(media) {
  if (!media || typeof media !== 'object') return null;
  const code = media.code || media.shortcode;
  // Reels são media_type 2 (vídeo). Fotos/carrosséis não têm áudio.
  const ehVideo = Number(media.media_type) === 2 || Array.isArray(media.video_versions) || media.is_video;
  if (!code || !ehVideo) return null;
  const legenda = String(media.caption?.text || media.edge_media_to_caption?.edges?.[0]?.node?.text || '').trim();
  const candidatos = media.image_versions2?.candidates || [];
  return {
    plataforma: 'instagram',
    externalId: String(code),
    url: `https://www.instagram.com/reel/${code}/`,
    titulo: textoCurto(legenda.split('\n')[0], 300) || null,
    legenda: legenda.slice(0, 5000) || null,
    autor: media.user?.username || media.owner?.username || null,
    thumbnail: candidatos[0]?.url || media.display_url || media.thumbnail_src || null,
    mediaUrl: media.video_versions?.[0]?.url || media.video_url || null,
  };
}

/** Shortcodes presentes no HTML (dados pré-carregados da página de Reels). */
function shortcodesDoHtml(html) {
  const codes = new Set();
  const texto = String(html || '');
  for (const m of texto.matchAll(/"code":"([A-Za-z0-9_-]{10,14})"/g)) codes.add(m[1]);
  for (const m of texto.matchAll(/\\?\/reels?\\?\/([A-Za-z0-9_-]{10,14})\\?\//g)) codes.add(m[1]);
  return [...codes];
}

async function coletarInstagram({ quantidade, seedUrl = '' }) {
  const {
    bootstrapInstagramSession,
    buildInstagramCookieHeader,
    instagramApiHeaders,
    instagramFailureReason,
    shortcodeToMediaId,
    diagnoseInstagramCookies,
  } = require('./instagramCookies');

  const diag = diagnoseInstagramCookies();
  if (!diag.ok) return { itens: [], origem: null, motivo: `Cookies do Instagram: ${diag.reason}` };

  const seedCode = shortcodeDoInstagram(seedUrl);
  const seedMediaId = seedCode ? shortcodeToMediaId(seedCode) : null;
  const itens = [];
  const vistos = new Set(seedCode ? [seedCode] : []);
  const adicionar = (item) => {
    if (!item || vistos.has(item.externalId)) return;
    vistos.add(item.externalId);
    itens.push(item);
  };

  const boot = await bootstrapInstagramSession(axios);
  const cookieHeader = boot?.cookieHeader || buildInstagramCookieHeader();
  const headers = instagramApiHeaders(cookieHeader, { mobile: false, wwwClaim: boot?.claim || '0' });
  let motivo = null;

  // 1) Mesmo endpoint que a aba Reels usa ao rolar (encadeado no Reel do link).
  let maxId = '';
  for (let pagina = 0; pagina < 8 && itens.length < quantidade; pagina += 1) {
    const corpo = new URLSearchParams({
      container_module: 'clips_viewer_clips_tab',
      page_size: '12',
      include_feed_video: 'true',
      ...(maxId ? { max_id: maxId } : {}),
      ...(seedMediaId ? { chaining_media_id: seedMediaId } : {}),
    });
    let resposta;
    try {
      resposta = await axios.post('https://www.instagram.com/api/v1/clips/discover/', corpo.toString(), {
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 25_000,
        maxRedirects: 3,
        validateStatus: () => true,
      });
    } catch (err) {
      motivo = `Instagram: ${err.message}`;
      break;
    }
    if (resposta.status < 200 || resposta.status >= 300 || typeof resposta.data !== 'object') {
      motivo = `Instagram recusou a lista de Reels: ${instagramFailureReason(resposta.data, resposta.status)}`;
      break;
    }
    const antes = itens.length;
    for (const entrada of resposta.data?.items || []) adicionar(itemDoMediaInstagram(entrada?.media || entrada));
    maxId = String(resposta.data?.paging_info?.max_id || '');
    const temMais = resposta.data?.paging_info?.more_available !== false;
    if (!maxId || !temMais || itens.length === antes) break;
    await pausaHumana();
  }
  if (itens.length >= quantidade) return { itens: itens.slice(0, quantidade), origem: 'clips-discover', motivo: null };

  // 2) Plano B: os Reels que já vêm no HTML da página (a primeira "tela").
  try {
    const alvo = seedCode ? `https://www.instagram.com/reels/${seedCode}/` : 'https://www.instagram.com/reels/';
    const html = await axios.get(alvo, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        Cookie: cookieHeader,
      },
      timeout: 25_000,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text',
    });
    const finalUrl = String(html.request?.res?.responseUrl || '');
    if (/\/accounts\/login|\/challenge\//i.test(finalUrl)) {
      motivo = motivo || 'Instagram pediu login/verificação: renove os cookies do Instagram.';
    } else {
      for (const code of shortcodesDoHtml(html.data)) {
        if (itens.length >= quantidade) break;
        adicionar({
          plataforma: 'instagram',
          externalId: code,
          url: `https://www.instagram.com/reel/${code}/`,
          titulo: null,
          legenda: null,
          autor: null,
          thumbnail: null,
          mediaUrl: null,
        });
      }
    }
  } catch (err) {
    motivo = motivo || `Instagram: ${err.message}`;
  }

  return {
    itens: itens.slice(0, quantidade),
    origem: itens.length ? 'clips-discover+html' : null,
    motivo: itens.length ? null : motivo || 'O Instagram não devolveu Reels sugeridos.',
  };
}

// ------------------------------------------------------------------ YouTube

function videoIdDoYoutube(url) {
  const m = String(url || '').match(/(?:shorts\/|[?&]v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function cookieHeaderDoYoutube() {
  const fs = require('fs');
  try {
    const file = require('./ytDlpAuth').getYtDlpAuthFlags({ platform: 'youtube' })?.cookies;
    if (!file || !fs.existsSync(file)) return '';
    const agora = Math.floor(Date.now() / 1000);
    const valores = new Map();
    for (const bruta of fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      let linha = bruta;
      if (linha.startsWith('#HttpOnly_')) linha = linha.slice('#HttpOnly_'.length);
      else if (!linha.trim() || linha.trimStart().startsWith('#')) continue;
      const partes = linha.split('\t');
      if (partes.length < 7) continue;
      const expira = Number(partes[4]) || 0;
      const nome = String(partes[5] || '').trim();
      const valor = String(partes.slice(6).join('\t') || '').trim();
      if (!String(partes[0]).toLowerCase().includes('youtube.com') || !nome || !valor) continue;
      if (expira > 0 && expira < agora) continue;
      valores.set(nome, valor);
    }
    return [...valores].map(([nome, valor]) => `${nome}=${valor}`).join('; ');
  } catch {
    return '';
  }
}

function rodarScriptShorts({ quantidade, seedId, tema }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [YOUTUBE_SHORTS_SCRIPT, String(quantidade), seedId || '', tema || ''],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    // Cookie pelo stdin: nunca aparece em argumentos, ps ou logs.
    child.stdin.end(cookieHeaderDoYoutube());
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error('O YouTube demorou demais para listar os Shorts.'));
    }, 120_000);
    child.stdout.on('data', (c) => {
      if (stdout.length < 500_000) stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < 4_000) stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim().split('\n')[0] || `script terminou com código ${code}`));
      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function coletarYoutube({ quantidade, seedUrl = '', tema = '' }) {
  try {
    const seedId = videoIdDoYoutube(seedUrl);
    const resultado = await rodarScriptShorts({ quantidade, seedId, tema });
    const itens = (resultado.itens || []).map((item) => ({
      plataforma: 'youtube',
      externalId: item.videoId,
      url: `https://www.youtube.com/shorts/${item.videoId}`,
      titulo: textoCurto(item.titulo, 300) || null,
      legenda: null,
      autor: null,
      thumbnail: `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
      mediaUrl: null,
    }));
    return {
      itens,
      origem: resultado.origem || null,
      motivo: itens.length ? null : 'O YouTube não devolveu Shorts sugeridos.',
    };
  } catch (err) {
    return { itens: [], origem: null, motivo: `YouTube: ${err.message}` };
  }
}

// ----------------------------------------------------------------- Facebook

function idDoVideoFacebook(url) {
  const texto = String(url || '');
  const m =
    texto.match(/facebook\.com\/(?:[^/?#]+\/)?(?:reel|videos)\/(\d{6,25})/i) ||
    texto.match(/[?&]v=(\d{6,25})/);
  return m ? m[1] : null;
}

/** IDs de Reels/vídeos presentes no HTML (JSON com barras escapadas). */
function videosDoHtmlFacebook(html) {
  const texto = String(html || '');
  const achados = new Map();
  for (const m of texto.matchAll(/\\?\/reel\\?\/(\d{8,25})/g)) {
    if (!achados.has(m[1])) achados.set(m[1], 'reel');
  }
  for (const m of texto.matchAll(/"video_id":"(\d{8,25})"/g)) {
    if (!achados.has(m[1])) achados.set(m[1], 'video');
  }
  for (const m of texto.matchAll(/\\?\/videos\\?\/(\d{8,25})/g)) {
    if (!achados.has(m[1])) achados.set(m[1], 'video');
  }
  return [...achados].map(([id, tipo]) => ({ id, tipo }));
}

async function coletarFacebook({ quantidade, seedUrl = '' }) {
  const {
    buildFacebookCookieHeader,
    facebookHtmlHeaders,
    diagnoseFacebookCookies,
  } = require('./facebookCookies');

  const diag = diagnoseFacebookCookies();
  if (!diag.ok) return { itens: [], origem: null, motivo: `Cookies do Facebook: ${diag.reason}` };
  const cookieHeader = buildFacebookCookieHeader();
  if (!cookieHeader) return { itens: [], origem: null, motivo: 'Cookies do Facebook vencidos ou incompletos.' };

  const seedId = idDoVideoFacebook(seedUrl);
  const itens = [];
  const vistos = new Set(seedId ? [seedId] : []);
  let motivo = null;
  let origem = null;

  const paginas = [
    ...(seedUrl && /^https?:\/\/([a-z0-9-]+\.)?facebook\.com\//i.test(seedUrl) ? [seedUrl] : []),
    'https://www.facebook.com/reel/',
    'https://www.facebook.com/watch/',
  ];

  for (const alvo of paginas) {
    if (itens.length >= quantidade) break;
    try {
      const resposta = await axios.get(alvo, {
        headers: facebookHtmlHeaders(cookieHeader),
        timeout: 25_000,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'text',
      });
      const finalUrl = String(resposta.request?.res?.responseUrl || '');
      if (/\/login|checkpoint/i.test(finalUrl) || /"USER_ID":"0"/.test(String(resposta.data || ''))) {
        motivo = 'O Facebook pediu login/verificação: renove os cookies do Facebook.';
        break;
      }
      for (const { id, tipo } of videosDoHtmlFacebook(resposta.data)) {
        if (itens.length >= quantidade) break;
        if (vistos.has(id)) continue;
        vistos.add(id);
        itens.push({
          plataforma: 'facebook',
          externalId: id,
          url: tipo === 'reel' ? `https://www.facebook.com/reel/${id}` : `https://www.facebook.com/watch/?v=${id}`,
          titulo: null,
          legenda: null,
          autor: null,
          thumbnail: null,
          mediaUrl: null,
        });
      }
      if (itens.length) origem = origem ? `${origem}+html` : 'html';
    } catch (err) {
      motivo = `Facebook: ${err.message}`;
    }
    await pausaHumana();
  }

  return {
    itens: itens.slice(0, quantidade),
    origem,
    motivo: itens.length ? null : motivo || 'O Facebook não devolveu vídeos sugeridos.',
  };
}

const COLETORES = {
  instagram: coletarInstagram,
  youtube: coletarYoutube,
  facebook: coletarFacebook,
};

async function coletarSugeridos(plataforma, opcoes) {
  const coletor = COLETORES[plataforma];
  if (!coletor) return { itens: [], origem: null, motivo: `Rede desconhecida: ${plataforma}` };
  return coletor(opcoes);
}

module.exports = {
  coletarSugeridos,
  pausaHumana,
  // exportados para testes
  shortcodeDoInstagram,
  shortcodesDoHtml,
  itemDoMediaInstagram,
  videoIdDoYoutube,
  idDoVideoFacebook,
  videosDoHtmlFacebook,
};
