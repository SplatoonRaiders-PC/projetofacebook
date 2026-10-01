const net = require('net');
const axios = require('axios');

/**
 * Envio de notificações para o app ntfy (https://ntfy.sh): o editor instala o
 * app, assina um tópico e recebe no celular o que o piloto publicou ou não.
 *
 * Publica em JSON (POST na raiz do servidor) porque os cabeçalhos do ntfy
 * (Title, Tags…) não aceitam acentos; no corpo JSON vai tudo em UTF-8.
 */

const SERVIDOR_PADRAO = 'https://ntfy.sh';
const TOPICO_VALIDO = /^[-_A-Za-z0-9]{6,64}$/;

function erro(status, mensagem) {
  return Object.assign(new Error(mensagem), { status });
}

/** IP literal de rede interna: o servidor não pode ser usado para chamar a própria rede. */
function hostInterno(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(h)) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe80/.test(h) || h.startsWith('::ffff:');
  return false;
}

/** Servidor ntfy: https público (ntfy.sh ou um próprio). Vazio = ntfy.sh. */
function normalizarServidor(valor) {
  const texto = String(valor || '').trim().replace(/\/+$/, '');
  if (!texto) return SERVIDOR_PADRAO;
  let url;
  try {
    url = new URL(texto);
  } catch {
    throw erro(400, 'Endereço do servidor ntfy inválido. Deixe em branco para usar o ntfy.sh.');
  }
  if (url.protocol !== 'https:') throw erro(400, 'O servidor ntfy precisa ser https://.');
  if (hostInterno(url.hostname)) throw erro(400, 'Use o endereço público do servidor ntfy.');
  if (url.username || url.password) throw erro(400, 'Não coloque usuário e senha no endereço; use o token de acesso.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function normalizarTopico(valor) {
  const topico = String(valor || '').trim();
  if (!topico) return null;
  if (!TOPICO_VALIDO.test(topico)) {
    throw erro(400, 'Tópico ntfy: use de 6 a 64 letras, números, "-" ou "_" (sem espaços nem acentos).');
  }
  return topico;
}

/**
 * Envia uma notificação. `prioridade` 1–5 (3 = normal); `tags` são emojis do
 * ntfy (ex.: "white_check_mark"); `clique` abre esse link ao tocar.
 */
async function enviar({ servidor, topico, token, titulo, mensagem, tags = [], prioridade = 3, clique = null, http = axios }) {
  const base = normalizarServidor(servidor);
  const alvo = normalizarTopico(topico);
  if (!alvo) throw erro(400, 'Informe o tópico do ntfy.');
  const corpo = {
    topic: alvo,
    title: String(titulo || '').slice(0, 250),
    message: String(mensagem || '').slice(0, 3_500),
    tags,
    priority: Math.min(5, Math.max(1, Number(prioridade) || 3)),
  };
  if (clique && /^https?:\/\//i.test(clique)) corpo.click = clique;
  try {
    await http.post(`${base}/`, corpo, {
      timeout: 10_000,
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) throw erro(400, 'O ntfy recusou o acesso: confira o token (tópico protegido).');
    if (status === 429) throw erro(429, 'O ntfy limitou os envios por agora. Tente de novo em alguns minutos.');
    throw erro(502, `Não foi possível enviar ao ntfy${status ? ` (HTTP ${status})` : `: ${err.message}`}.`);
  }
}

module.exports = { SERVIDOR_PADRAO, enviar, normalizarServidor, normalizarTopico };
