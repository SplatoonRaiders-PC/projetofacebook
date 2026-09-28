const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const gateway = require('../src/services/tokenFreeGatewayService');

function carregar(arquivo, mocks) {
  const filename = path.resolve(__dirname, '../src/services', arquivo);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, console,
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
  }, { filename });
  return module.exports;
}

function preparar() {
  const tabelas = {
    feed_sugerido_jobs: [], feed_sugerido_itens: [],
    materia_modelos: [
      { id: 1, modelo: 'claude-sonnet-5', habilitado: true, padrao: true },
      { id: 2, modelo: 'gpt-5.6', habilitado: true, padrao: false },
    ],
  };
  const campo = (nome) => nome.split('.').pop();
  const db = (tabela) => {
    const filtros = [];
    const linhas = () => tabelas[tabela].filter((r) => filtros.every((f) => f(r)));
    const query = {
      where(k, v) {
        if (typeof k === 'object') filtros.push((r) => Object.entries(k).every(([c, x]) => r[c] === x));
        else filtros.push((r) => r[campo(k)] === v);
        return this;
      },
      whereIn(k, valores) { filtros.push((r) => valores.includes(r[campo(k)])); return this; },
      whereNotIn(k, valores) { filtros.push((r) => !valores.includes(r[campo(k)])); return this; },
      leftJoin() { return this; }, orderBy() { return this; }, limit() { return this; },
      select() { return this; },
      count() { return { first: async () => ({ n: linhas().length }) }; },
      first: async () => linhas()[0] ? { ...linhas()[0] } : undefined,
      then(resolve, reject) { return Promise.resolve(linhas().map((r) => ({ ...r }))).then(resolve, reject); },
      async insert(dados) {
        return (Array.isArray(dados) ? dados : [dados]).map((r) => {
          const id = tabelas[tabela].length + 1;
          tabelas[tabela].push({ id, total: 0, concluidos: 0, falhas: 0, ...r });
          return id;
        });
      },
      async update(dados) { linhas().forEach((r) => Object.assign(r, dados)); },
      async increment(k, n) { linhas().forEach((r) => { r[k] = (r[k] || 0) + n; }); },
    };
    return query;
  };
  db.fn = { now: () => new Date() };
  const modelos = carregar('materiaModelosService.js', {
    '../config/db': db, './tokenFreeGatewayService': gateway,
  });
  const chamadas = [];
  let falhar = false;
  const service = carregar('feedSugeridoService.js', {
    '../config/db': db,
    './feedSugeridoConfig': {
      PLATAFORMAS: ['instagram'], ROTULOS: { instagram: 'Instagram' },
      lerConfig: async () => ({ plataformas: { instagram: true }, maxPorRede: 10 }),
    },
    './feedSugeridoColetor': {
      pausaHumana: async () => {},
      coletarSugeridos: async () => ({ itens: [1, 2].map((id) => ({
        externalId: String(id), url: `https://www.instagram.com/reel/test${id}/`, titulo: `Vídeo ${id}`,
      })) }),
    },
    './facebookPageResolver': { defaultPageForUser: async () => ({ id: 7 }) },
    './deepseekService': { usarTokenFree: () => true },
    './materiaModelosService': modelos,
    './tokenFreeGatewayService': gateway,
    '../models/AiMatters': { findById: async () => ({ titulo: 'Matéria pronta' }) },
    './materiaChatService': {
      responder: async () => {
        await new Promise((r) => setImmediate(r));
        chamadas.push(gateway.bodyDaChamada([{ role: 'user', content: 'Escreva' }], { tarefa: 'conversa' }).model);
        if (falhar) throw new Error('Limite de geração atingido');
        return { chatId: 3, mensagem: { id: chamadas.length, ehMateria: true } };
      },
      salvarMateriaDoChat: async () => ({ matterId: chamadas.length }),
      renomearConversa: async () => {}, excluirConversa: async () => {},
    },
  });
  const esperar = async (id) => {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      const job = await service.obterJob(1, id);
      if (['concluido', 'erro', 'aguardando_escolha'].includes(job.status)) return job;
    }
    throw new Error('O lote não terminou');
  };
  return { service, modelos, chamadas, tabelas, esperar, falhar: (valor) => { falhar = valor; } };
}

test('Feed persiste ChatGPT escolhido e envia todos os vídeos para ele', async () => {
  const ctx = preparar();
  const job = await ctx.service.criarJob(1, { plataformas: ['instagram'], quantidade: 2, modelo: 'gpt-5.6' });
  const final = await ctx.esperar(job.id);
  assert.equal(final.opcoes.modelo, 'gpt-5.6');
  assert.equal(final.concluidos, 2);
  assert.deepEqual(ctx.chamadas, ['gpt-5.6', 'gpt-5.6']);
  assert.equal(gateway.modeloAtual(), gateway.MODELO);
});

test('refazer vídeos que falharam usa a nova escolha', async () => {
  const ctx = preparar();
  ctx.falhar(true);
  const job = await ctx.service.criarJob(1, { plataformas: ['instagram'], quantidade: 1, modelo: 'claude-sonnet-5' });
  const falhou = await ctx.esperar(job.id);
  assert.equal(falhou.falhas, 1);
  ctx.falhar(false);
  await ctx.service.escolherItens(1, job.id, [falhou.itens[0].id], { modelo: 'gpt-5.6' });
  const final = await ctx.esperar(job.id);
  assert.equal(final.opcoes.modelo, 'gpt-5.6');
  assert.equal(final.concluidos, 1);
  assert.deepEqual(ctx.chamadas, ['claude-sonnet-5', 'gpt-5.6']);
});

test('escolha indisponível é rejeitada antes da coleta, sem trocar por Claude', async () => {
  const ctx = preparar();
  ctx.tabelas.materia_modelos[1].habilitado = false;
  await assert.rejects(ctx.service.criarJob(1, { plataformas: ['instagram'], modelo: 'gpt-5.6' }), /não está mais habilitado/);
  assert.equal(ctx.tabelas.feed_sugerido_jobs.length, 0);
  assert.equal(ctx.chamadas.length, 0);
});

test('lote retomado após reinício conserva o modelo salvo', async () => {
  const ctx = preparar();
  ctx.tabelas.feed_sugerido_jobs.push({ id: 1, user_id: 1, status: 'na_fila', plataformas: 'instagram', quantidade: 1, concluidos: 0, falhas: 0, opcoes: JSON.stringify({ modelo: 'gpt-5.6' }) });
  await ctx.service.retomarAposReinicio();
  const final = await ctx.esperar(1);
  assert.equal(final.concluidos, 1);
  assert.deepEqual(ctx.chamadas, ['gpt-5.6']);
});

test('painel envia a seleção do chat na coleta e ao refazer vídeos', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/views/materia-manual.ejs'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/materia-manual' });
  const { window } = dom;
  const payloads = [];
  window.document.getElementById('chat-ai-model').dataset.modelo = 'gpt-5.6';
  const job = {
    id: 1, status: 'concluido', plataformas: ['instagram'], opcoes: { modelo: 'gpt-5.6' },
    itens: [{ id: 1, plataforma: 'instagram', url: 'https://example.test/video', status: 'erro' }],
  };
  window.fetch = async (url, options = {}) => {
    if (options.method === 'POST') payloads.push(JSON.parse(options.body));
    const data = url.endsWith('/config')
      ? { plataformas: [{ id: 'instagram', nome: 'Instagram', habilitada: true, cookiesOk: true }], maxPorRede: 10 }
      : options.method === 'POST' ? { job } : { jobs: [] };
    return { ok: true, json: async () => data };
  };
  try {
    window.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/feed-sugerido.js'), 'utf8'));
    await new Promise((r) => setImmediate(r));
    window.document.getElementById('feed-sugerido-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(payloads[0].modelo, 'gpt-5.6');
    assert.match(window.document.getElementById('feed-sugerido-job-modelo').textContent, /gpt-5.6/);
    window.document.querySelector('#feed-sugerido-itens input[data-item]').checked = true;
    window.document.getElementById('feed-sugerido-escrever').disabled = false;
    window.document.getElementById('feed-sugerido-escrever').click();
    await new Promise((r) => setImmediate(r));
    assert.equal(payloads[1].modelo, 'gpt-5.6');
    assert.deepEqual(payloads[1].itens, [1]);
  } finally {
    window.close();
  }
});
