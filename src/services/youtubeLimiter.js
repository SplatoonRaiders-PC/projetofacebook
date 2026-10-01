/**
 * Ritmo das chamadas ao YouTube.
 *
 * O YouTube limita por IP: muitas requisições seguidas terminam em HTTP 429 e
 * na tela "confirme que você não é um robô", e insistir só prolonga o
 * bloqueio. Por isso toda chamada (yt-dlp, página do vídeo, legenda, busca)
 * passa por aqui:
 *   - uma de cada vez, com um intervalo mínimo entre os inícios;
 *   - ao primeiro sinal de bloqueio, tudo para por um tempo (pausa), em vez
 *     de cada parte do sistema continuar tentando por conta própria.
 *
 * Ajustável no .env:
 *   YOUTUBE_INTERVALO_MS   intervalo entre chamadas (padrão 5000)
 *   YOUTUBE_PAUSA_MIN      1ª pausa após bloqueio, em minutos (padrão 30)
 *   YOUTUBE_PAUSA_MAX_MIN  teto da pausa, que dobra a cada bloqueio seguido (padrão 120)
 */

// Dentro do `node --test` não há por que esperar entre chamadas simuladas.
const INTERVALO_PADRAO_MS = process.env.NODE_TEST_CONTEXT ? 0 : 5_000;
const INTERVALO_MS = Math.max(0, Number(process.env.YOUTUBE_INTERVALO_MS ?? INTERVALO_PADRAO_MS) || 0);
const PAUSA_MS = Math.max(1, Number(process.env.YOUTUBE_PAUSA_MIN) || 30) * 60_000;
const PAUSA_MAX_MS = Math.max(PAUSA_MS, (Number(process.env.YOUTUBE_PAUSA_MAX_MIN) || 120) * 60_000);
/** Um "não é um robô" isolado pode ser só do vídeo; dois em 10 min é o IP. */
const JANELA_ANTIBOT_MS = 10 * 60_000;

let fila = Promise.resolve();
let ultimoInicio = 0;
let pausadoAte = 0;
let motivoDaPausa = '';
let bloqueiosSeguidos = 0;
let ultimoAntiBot = 0;

function hora(ms) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Araguaina', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

function emPausa(agora = Date.now()) {
  return pausadoAte > agora;
}

function erroDePausa() {
  const err = new Error(
    `O YouTube limitou este servidor (${motivoDaPausa}). As consultas ao YouTube estão em pausa até ${hora(pausadoAte)} para o bloqueio passar.`
  );
  err.status = 503;
  err.code = 'YOUTUBE_EM_PAUSA';
  return err;
}

/**
 * Espera a vez de falar com o YouTube. Lança YOUTUBE_EM_PAUSA, sem fazer a
 * chamada, enquanto durar a pausa por bloqueio.
 */
function esperarVez() {
  const vez = fila.then(async () => {
    if (emPausa()) throw erroDePausa();
    const falta = ultimoInicio + INTERVALO_MS - Date.now();
    if (falta > 0) await new Promise((resolve) => setTimeout(resolve, falta));
    if (emPausa()) throw erroDePausa();
    ultimoInicio = Date.now();
  });
  // Quem foi barrado pela pausa não segura a fila dos próximos.
  fila = vez.catch(() => {});
  return vez;
}

/** O erro indica limite por IP? (429 ou verificação anti-bot) */
function tipoDeBloqueio(err) {
  if (err?.code === 'YOUTUBE_EM_PAUSA') return null;
  const status = Number(err?.response?.status || err?.status || 0);
  const texto = String(err?.stderr || err?.message || err || '').toLowerCase();
  if (status === 429 || /\b(http|error|status)\s*(error\s*|code\s*)?429\b/.test(texto) || texto.includes('too many requests')) return '429';
  if (texto.includes('not a bot') || texto.includes('unusual traffic')) return 'antibot';
  return null;
}

/**
 * Avisa o limitador de uma falha. Devolve true quando ela iniciou (ou
 * confirmou) a pausa.
 */
function registrarFalha(err) {
  const tipo = tipoDeBloqueio(err);
  if (!tipo) return false;
  const agora = Date.now();
  if (tipo === 'antibot') {
    const primeiro = agora - ultimoAntiBot > JANELA_ANTIBOT_MS;
    ultimoAntiBot = agora;
    if (primeiro) return false;
  }
  if (emPausa(agora)) return true;
  bloqueiosSeguidos += 1;
  const duracao = Math.min(PAUSA_MAX_MS, PAUSA_MS * 2 ** (bloqueiosSeguidos - 1));
  pausadoAte = agora + duracao;
  motivoDaPausa = tipo === '429' ? 'HTTP 429, requisições demais' : 'verificação anti-bot';
  console.warn(`[youtube] bloqueio (${motivoDaPausa}): consultas em pausa por ${Math.round(duracao / 60_000)} min, até ${hora(pausadoAte)}`);
  return true;
}

/** Uma resposta boa zera a contagem: a próxima pausa volta ao tempo inicial. */
function registrarSucesso() {
  bloqueiosSeguidos = 0;
  ultimoAntiBot = 0;
}

function estado() {
  const pausado = emPausa();
  return {
    pausado,
    ate: pausado ? new Date(pausadoAte).toISOString() : null,
    motivo: pausado ? motivoDaPausa : null,
    intervaloMs: INTERVALO_MS,
  };
}

/** Só para testes. */
function reiniciar() {
  fila = Promise.resolve();
  ultimoInicio = 0;
  pausadoAte = 0;
  motivoDaPausa = '';
  bloqueiosSeguidos = 0;
  ultimoAntiBot = 0;
}

module.exports = { esperarVez, registrarFalha, registrarSucesso, tipoDeBloqueio, emPausa, erroDePausa, estado, reiniciar, INTERVALO_MS };
