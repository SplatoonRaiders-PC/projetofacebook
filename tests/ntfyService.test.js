const test = require('node:test');
const assert = require('node:assert/strict');

const ntfy = require('../src/services/ntfyService');

test('publica em JSON na raiz do servidor, com acentos e token', async () => {
  const chamadas = [];
  const http = { async post(url, corpo, opcoes) { chamadas.push({ url, corpo, opcoes }); return { status: 200 }; } };
  await ntfy.enviar({
    topico: 'viralizeai-k3p9x2',
    token: 'tk_abc',
    titulo: 'Não publicada · Página Gospel',
    mensagem: 'Matéria sobre ação social\n\nMotivo: sem imagem',
    tags: ['x'],
    prioridade: 4,
    clique: 'https://www.viralizeai.online/materias-ia/1',
    http,
  });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'https://ntfy.sh/');
  assert.deepEqual(chamadas[0].corpo, {
    topic: 'viralizeai-k3p9x2',
    title: 'Não publicada · Página Gospel',
    message: 'Matéria sobre ação social\n\nMotivo: sem imagem',
    tags: ['x'],
    priority: 4,
    click: 'https://www.viralizeai.online/materias-ia/1',
  });
  assert.equal(chamadas[0].opcoes.headers.Authorization, 'Bearer tk_abc');
});

test('valida tópico e servidor', () => {
  assert.equal(ntfy.normalizarTopico('viralizeai-abc_123'), 'viralizeai-abc_123');
  assert.equal(ntfy.normalizarTopico(''), null);
  assert.throws(() => ntfy.normalizarTopico('abc'), /6 a 64/);
  assert.throws(() => ntfy.normalizarTopico('meu tópico'), /6 a 64/);
  assert.equal(ntfy.normalizarServidor(''), 'https://ntfy.sh');
  assert.equal(ntfy.normalizarServidor('https://ntfy.meudominio.com/'), 'https://ntfy.meudominio.com');
  assert.throws(() => ntfy.normalizarServidor('http://ntfy.sh'), /https/);
  assert.throws(() => ntfy.normalizarServidor('https://127.0.0.1'), /público/);
  assert.throws(() => ntfy.normalizarServidor('https://localhost:8080'), /público/);
  assert.throws(() => ntfy.normalizarServidor('https://192.168.0.10'), /público/);
});

test('token recusado vira mensagem clara', async () => {
  const http = { async post() { throw Object.assign(new Error('403'), { response: { status: 403 } }); } };
  await assert.rejects(ntfy.enviar({ topico: 'viralizeai-k3p9x2', titulo: 't', mensagem: 'm', http }), /token/);
});
