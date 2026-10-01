const test = require('node:test');
const assert = require('node:assert/strict');

const limiter = require('../src/services/youtubeLimiter');

test('HTTP 429 pausa as consultas ao YouTube e barra as próximas sem chamar', async () => {
  limiter.reiniciar();
  await limiter.esperarVez();
  assert.equal(limiter.emPausa(), false);

  const erro429 = Object.assign(new Error('Request failed'), { response: { status: 429 } });
  assert.equal(limiter.registrarFalha(erro429), true);
  assert.equal(limiter.emPausa(), true);
  await assert.rejects(limiter.esperarVez(), (err) => err.code === 'YOUTUBE_EM_PAUSA' && /em pausa até/.test(err.message));
  // A própria mensagem de pausa não conta como novo bloqueio.
  assert.equal(limiter.tipoDeBloqueio(limiter.erroDePausa()), null);
  limiter.reiniciar();
});

test('um "not a bot" isolado não pausa; dois seguidos pausam', () => {
  limiter.reiniciar();
  const antibot = { stderr: "ERROR: [youtube] abc: Sign in to confirm you're not a bot" };
  assert.equal(limiter.registrarFalha(antibot), false);
  assert.equal(limiter.emPausa(), false);
  assert.equal(limiter.registrarFalha(antibot), true);
  assert.equal(limiter.estado().motivo, 'verificação anti-bot');
  limiter.reiniciar();
});

test('erros comuns não são tratados como bloqueio', () => {
  limiter.reiniciar();
  assert.equal(limiter.tipoDeBloqueio(new Error('Video unavailable')), null);
  assert.equal(limiter.tipoDeBloqueio({ stderr: 'Sign in to confirm your age' }), null);
  assert.equal(limiter.tipoDeBloqueio({ stderr: 'HTTP Error 429: Too Many Requests' }), '429');
  assert.equal(limiter.tipoDeBloqueio(new Error('HTTP 429: limitado')), '429');
  assert.equal(limiter.registrarFalha(new Error('timeout')), false);
  assert.equal(limiter.emPausa(), false);
});

test('yt-dlp de link do YouTube respeita a pausa; outros links não', async () => {
  limiter.reiniciar();
  const { runYtDlp } = require('../src/services/ytDlpAuth');
  let chamadas = 0;
  const exec = async () => {
    chamadas += 1;
    return { id: 'x' };
  };
  await runYtDlp(exec, 'https://www.youtube.com/watch?v=abc', {}, { noCookies: true });
  assert.equal(chamadas, 1);

  limiter.registrarFalha(Object.assign(new Error('x'), { response: { status: 429 } }));
  await assert.rejects(
    runYtDlp(exec, 'https://www.youtube.com/watch?v=abc', {}, { noCookies: true }),
    (err) => err.code === 'YOUTUBE_EM_PAUSA'
  );
  assert.equal(chamadas, 1);
  await runYtDlp(exec, 'https://www.tiktok.com/@a/video/1', {}, { noCookies: true });
  assert.equal(chamadas, 2);
  limiter.reiniciar();
});
