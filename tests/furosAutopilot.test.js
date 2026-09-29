const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

/** Banco em memória com o pedaço do knex que o piloto usa. */
function criarDb(tabelas) {
  const valorDe = (linha, coluna) => {
    const [prefixo, nome] = coluna.includes('.') ? coluna.split('.') : [null, coluna];
    if (prefixo === 'c' && linha.__c) return linha.__c[nome];
    return linha[nome];
  };
  const compara = { '<': (a, b) => a < b, '>=': (a, b) => a >= b, '>': (a, b) => a > b, '=': (a, b) => a === b };
  const db = (nomeTabela) => {
    const tabela = String(nomeTabela).split(' as ')[0];
    const filtros = [];
    let ordem = null;
    let juntar = null;
    let limite = null;
    const linhas = () => {
      let base = tabelas[tabela];
      if (juntar) base = base.map((r) => Object.assign(Object.create(null), r, { __c: tabelas[juntar].find((c) => c.user_id === r.user_id) }));
      let saida = base.filter((r) => filtros.every((f) => f(r)));
      if (ordem) saida = [...saida].sort(ordem);
      return limite ? saida.slice(0, limite) : saida;
    };
    const tempo = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : v);
    const q = {
      where(a, b, c) {
        if (typeof a === 'object') filtros.push((r) => Object.entries(a).every(([k, v]) => valorDe(r, k) === v));
        else if (c === undefined) filtros.push((r) => valorDe(r, a) === b);
        else filtros.push((r) => valorDe(r, a) != null && compara[b](tempo(valorDe(r, a)), tempo(c)));
        return q;
      },
      whereIn(k, vs) { filtros.push((r) => vs.includes(valorDe(r, k))); return q; },
      whereNot(k, v) { filtros.push((r) => valorDe(r, k) !== v); return q; },
      join(outra) { juntar = String(outra).split(' as ')[0]; return q; },
      orderBy() { return q; },
      orderByRaw() {
        ordem = (x, y) => ((y.nota_ia ?? y.score) - (x.nota_ia ?? x.score)) || x.id - y.id;
        return q;
      },
      limit(n) { limite = n; return q; },
      select() { return q; },
      leftJoin() { return q; },
      groupBy() { return q; },
      count() {
        const porStatus = () => {
          const mapa = new Map();
          for (const r of linhas()) mapa.set(r.status, (mapa.get(r.status) || 0) + 1);
          return [...mapa].map(([status, n]) => ({ status, n }));
        };
        return {
          first: async () => ({ n: linhas().length }),
          then: (ok, falha) => Promise.resolve(porStatus()).then(ok, falha),
        };
      },
      async first() { const r = linhas()[0]; return r ? { ...r, ...(r.__c ? { foto_original_se_falhar: r.__c.foto_original_se_falhar } : {}) } : undefined; },
      then(ok, falha) { return Promise.resolve(linhas().map((r) => ({ ...r }))).then(ok, falha); },
      async update(dados) {
        const alvo = linhas();
        for (const r of alvo) {
          const original = tabelas[tabela].find((x) => x.id === r.id);
          for (const [k, v] of Object.entries(dados)) if (k !== 'updated_at') original[k] = v;
          original.updated_at = new Date();
        }
        return alvo.length;
      },
      insert(dados) {
        const inserir = async (ignorarDuplicado) => {
          for (const d of Array.isArray(dados) ? dados : [dados]) {
            if (ignorarDuplicado && tabelas[tabela].some((r) => r.user_id === d.user_id && r.chave === d.chave)) continue;
            tabelas[tabela].push({ id: tabelas[tabela].length + 1, tentativas: 0, created_at: new Date(), updated_at: new Date(), ...d });
          }
        };
        return {
          onConflict: () => ({ ignore: () => inserir(true) }),
          then: (ok, falha) => inserir(false).then(ok, falha),
        };
      },
    };
    return q;
  };
  db.fn = { now: () => new Date() };
  return db;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function carregar({ imagem, avaliacoes = null, furos = [] }) {
  const tabelas = {
    furos_autopilot: [{ id: 1, user_id: 1, ativo: true, intervalo_minutos: 10, limite_dia: 40, facebook_page_id: 7,
      foto_original_se_falhar: true, ultimo_scan_at: new Date(), proxima_postagem_at: null, nichos: '["auto"]', canais: '["noticias"]', horas: 24 }],
    furos_autopilot_itens: [],
    ai_matters: [],
  };
  const matters = new Map();
  const eventos = { imagensJuntas: 0, maxImagens: 0, escritasDuranteImagem: 0, publicadas: [] };
  const mocks = {
    '../config/db': criarDb(tabelas),
    './furosService': {
      NICHOS: [{ id: 'igreja' }], CANAIS: ['noticias'],
      buscarFuros: async () => ({ furos }),
      gerarFuro: async ({ pauta }) => {
        if (eventos.imagensJuntas > 0) eventos.escritasDuranteImagem += 1;
        await esperar(5);
        const id = matters.size + 1;
        matters.set(id, { id, titulo: pauta.titulo, imagem_path: 'artes/foto.jpg' });
        return { matterId: id };
      },
    },
    './materiaPorChat': {
      aplicarCapaChatgpt: async () => {
        eventos.imagensJuntas += 1;
        eventos.maxImagens = Math.max(eventos.maxImagens, eventos.imagensJuntas);
        try {
          await imagem();
        } finally {
          eventos.imagensJuntas -= 1;
        }
      },
    },
    '../models/AiMatters': {
      findById: async (id) => matters.get(Number(id)) || null,
      update: async () => {},
      findViralizadasDaConta: async () => [{ titulo: 'Base', pub_fb_likes: 100, facebook_page_id: 7 }],
    },
    './materiaIaService': {
      publicarMateria: async (_u, matterId) => { eventos.publicadas.push(matterId); return { postId: 'x' }; },
      marcarJaPublicados: async (_u, _p, lista) => lista,
    },
    './deepseekService': {
      usarTokenFree: () => false,
      ranquearPautasParaPublico: async () => avaliacoes || [],
    },
    './newsResearch': { titulosSimilares: (a, b) => a === b },
  };
  const filename = path.resolve(__dirname, '../src/services/furosAutopilotService.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, console, setTimeout, clearTimeout, setInterval, setImmediate, Date, URL,
    require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id)),
  }, { filename });
  return { service: module.exports, tabelas, eventos };
}

function naFila(tabelas, n) {
  for (let i = 1; i <= n; i += 1) {
    tabelas.furos_autopilot_itens.push({
      id: i, user_id: 1, chave: `k${i}`, canal: 'noticias', titulo: `Pauta ${i}`, url: `https://ex.test/${i}`,
      pauta: JSON.stringify({ titulo: `Pauta ${i}`, url: `https://ex.test/${i}` }), score: 50 - i, nota_ia: 90 - i,
      status: 'na_fila', tentativas: 0, created_at: new Date(), updated_at: new Date(),
    });
  }
}

async function rodar(service, voltas, ms = 15) {
  for (let i = 0; i < voltas; i += 1) {
    await service.tick();
    await esperar(ms);
  }
}

test('no máximo 2 imagens ao mesmo tempo, com a escrita andando em paralelo', async () => {
  const ctx = carregar({ imagem: () => esperar(60) });
  naFila(ctx.tabelas, 6);
  await rodar(ctx.service, 25);
  assert.equal(ctx.eventos.maxImagens, 2);
  assert.ok(ctx.eventos.escritasDuranteImagem >= 1, 'escreveu outra matéria enquanto gerava imagem');
});

test('publica uma por intervalo e só com imagem pronta', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  naFila(ctx.tabelas, 4);
  await rodar(ctx.service, 20);
  // A primeira sai logo; as outras esperam os 10 min do intervalo.
  assert.equal(ctx.eventos.publicadas.length, 1);
  const cfg = ctx.tabelas.furos_autopilot[0];
  assert.ok(new Date(cfg.proxima_postagem_at).getTime() - Date.now() > 9 * 60_000);
  // Passado o intervalo, sai a próxima (a de maior nota).
  cfg.proxima_postagem_at = new Date(Date.now() - 1000);
  await rodar(ctx.service, 3);
  assert.equal(ctx.eventos.publicadas.length, 2);
  const publicadas = ctx.tabelas.furos_autopilot_itens.filter((i) => i.status === 'publicada');
  assert.ok(publicadas.every((i) => i.imagem_ia === true));
});

test('imagem que falha 2 vezes: vai com a foto original ou não é publicada', async () => {
  const comFoto = carregar({ imagem: async () => { throw new Error('ChatGPT fora'); } });
  naFila(comFoto.tabelas, 1);
  await rodar(comFoto.service, 10);
  const item = comFoto.tabelas.furos_autopilot_itens[0];
  assert.equal(item.tentativas, 2);
  assert.equal(item.imagem_ia, false);
  assert.equal(comFoto.eventos.publicadas.length, 1);

  const semFoto = carregar({ imagem: async () => { throw new Error('ChatGPT fora'); } });
  semFoto.tabelas.furos_autopilot[0].foto_original_se_falhar = false;
  naFila(semFoto.tabelas, 1);
  await rodar(semFoto.service, 10);
  assert.equal(semFoto.tabelas.furos_autopilot_itens[0].status, 'erro');
  assert.equal(semFoto.eventos.publicadas.length, 0);
});

test('varredura: a IA descarta pauta fraca e nada entra duas vezes', async () => {
  const furos = [
    { canal: 'noticias', titulo: 'Forte A', url: 'https://ex.test/a', score: 40, resumo: '' },
    { canal: 'noticias', titulo: 'Fraca B', url: 'https://ex.test/b', score: 40, resumo: '' },
    { canal: 'noticias', titulo: 'Boa C', url: 'https://ex.test/c', score: 30, resumo: '' },
  ];
  const avaliacoes = [
    { id: 'p1', potencial: 80, afinidade: 70, motivo: 'polêmica' },
    { id: 'p2', potencial: 10, afinidade: 5, motivo: 'agenda' },
    { id: 'p3', potencial: 60, afinidade: 40, motivo: 'fato novo' },
  ];
  const ctx = carregar({ imagem: () => esperar(5), avaliacoes, furos });
  ctx.tabelas.furos_autopilot[0].ativo = false; // só a varredura, sem escrever
  await ctx.service.escanearAgora(1);
  await esperar(30);
  const porTitulo = Object.fromEntries(ctx.tabelas.furos_autopilot_itens.map((i) => [i.titulo, i.status]));
  assert.deepEqual(porTitulo, { 'Forte A': 'na_fila', 'Boa C': 'na_fila', 'Fraca B': 'descartada' });

  await ctx.service.escanearAgora(1);
  await esperar(30);
  assert.equal(ctx.tabelas.furos_autopilot_itens.length, 3);
});

test('painel: marcar Automatizar confirma e envia filtros, intervalo e página', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/views/materia-manual.ejs'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/materia-manual' });
  const { window } = dom;
  const enviados = [];
  let confirmou = false;
  window.confirm = () => { confirmou = true; return true; };
  window.localStorage.setItem('ViralizeAI.furosNichos', JSON.stringify(['pastores']));
  window.localStorage.setItem('ViralizeAI.furosCanais', JSON.stringify(['noticias', 'youtube']));
  const status = (ativo) => ({
    config: { ativo, intervalo_minutos: 15, limite_dia: 40, facebook_page_id: 7, foto_original_se_falhar: true },
    contagens: {}, publicadasHoje: 0, itens: [], maxImagens: 2,
  });
  window.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') enviados.push(JSON.parse(options.body));
    const data = url.includes('/api/facebook/pages')
      ? { pages: [{ id: 7, page_name: 'Página Gospel' }], default_facebook_page_id: 7 }
      : status(options.method === 'PUT');
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    window.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/materia-furos-auto.js'), 'utf8'));
    const doc = window.document;
    doc.getElementById('furos-dialog').hidden = false;
    await esperar(30);
    doc.getElementById('furos-auto-intervalo').value = '15';
    doc.getElementById('furos-auto-ativo').checked = true;
    doc.getElementById('furos-auto-ativo').dispatchEvent(new window.Event('change'));
    await esperar(30);
    assert.ok(confirmou);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].ativo, true);
    assert.equal(enviados[0].intervalo_minutos, 15);
    assert.equal(enviados[0].facebook_page_id, '7');
    assert.deepEqual(enviados[0].nichos, ['pastores']);
    assert.deepEqual(enviados[0].canais, ['noticias', 'youtube']);
    assert.match(doc.getElementById('furos-auto-resumo').textContent, /Ligado · posta a cada 15 min/);
  } finally {
    window.close();
  }
});
