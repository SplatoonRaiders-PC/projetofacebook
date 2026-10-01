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
          catch: (falha) => Promise.resolve(porStatus()).catch(falha),
        };
      },
      async first() { const r = linhas()[0]; return r ? { ...r, ...(r.__c ? { foto_original_se_falhar: r.__c.foto_original_se_falhar } : {}) } : undefined; },
      then(ok, falha) { return Promise.resolve(linhas().map((r) => ({ ...r }))).then(ok, falha); },
      catch(falha) { return Promise.resolve(linhas().map((r) => ({ ...r }))).catch(falha); },
      async delete() {
        const alvo = new Set(linhas().map((r) => r.id));
        tabelas[tabela] = tabelas[tabela].filter((r) => !alvo.has(r.id));
        return alvo.size;
      },
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

function carregar({ imagem, avaliacoes = null, furos = [], gerarFuro = null, gateway = false }) {
  const tabelas = {
    furos_autopilot: [{ id: 1, user_id: 1, ativo: true, intervalo_minutos: 10, limite_dia: 40, facebook_page_id: 7,
      foto_original_se_falhar: true, ultimo_scan_at: new Date(), proxima_postagem_at: null, nichos: '["auto"]', canais: '["noticias"]', horas: 24 }],
    furos_autopilot_itens: [],
    ai_matters: [],
    ai_fila_jobs: [],
    facebook_pages: [{ id: 7, page_name: 'Gospel Geral' }],
  };
  const matters = new Map();
  const eventos = { imagensJuntas: 0, maxImagens: 0, escritasDuranteImagem: 0, publicadas: [], avisos: [] };
  const mocks = {
    '../config/db': criarDb(tabelas),
    './furosService': {
      NICHOS: [{ id: 'igreja' }], CANAIS: ['noticias'], JANELAS_HORAS: [24],
      palavrasValidas: (v) => (Array.isArray(v) ? v : []),
      buscarFuros: async (opcoes) => {
        eventos.buscas = [...(eventos.buscas || []), opcoes];
        return { furos };
      },
      linkDiretoPeloTitulo: async () => null,
      gerarFuro: async ({ pauta }) => {
        eventos.peloFuro = (eventos.peloFuro || 0) + 1;
        if (gerarFuro) await gerarFuro(pauta);
        if (eventos.imagensJuntas > 0) eventos.escritasDuranteImagem += 1;
        await esperar(5);
        const id = matters.size + 1;
        matters.set(id, { id, titulo: pauta.titulo, imagem_path: 'artes/foto.jpg' });
        return { matterId: id };
      },
    },
    './materiaPorChat': {
      escreverPeloChat: async (_deps, { url, modelo }) => {
        eventos.peloChat = [...(eventos.peloChat || []), { url, modelo }];
        const id = matters.size + 1;
        matters.set(id, { id, titulo: 'Escrita pelo chat', imagem_path: 'artes/foto.jpg' });
        return { matterId: id, chatId: 1 };
      },
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
    '../models/Publications': { historyForDedupe: async () => [] },
    '../models/AiFilaJobs': {
      create: async (dados) => {
        tabelas.ai_fila_jobs.push({ id: tabelas.ai_fila_jobs.length + 1, ...dados });
        return [tabelas.ai_fila_jobs.length];
      },
      update: async (id, dados) => Object.assign(tabelas.ai_fila_jobs.find((j) => j.id === id) || {}, dados),
    },
    '../models/AiMatters': {
      findById: async (id) => (matters.has(Number(id)) ? { ...matters.get(Number(id)) } : null),
      update: async (id, dados) => {
        if (matters.has(Number(id))) Object.assign(matters.get(Number(id)), dados);
      },
      findViralizadasDaConta: async () => [{ titulo: 'Base', pub_fb_likes: 100, facebook_page_id: 7 }],
    },
    './materiaIaService': {
      publicarMateria: async (_u, matterId) => { eventos.publicadas.push(matterId); return { postId: 'x' }; },
      marcarJaPublicados: async (_u, _p, lista) => lista,
      gerarMateriaManual: async ({ informacoes }) => {
        eventos.apuradas = (eventos.apuradas || 0) + 1;
        const id = matters.size + 1;
        matters.set(id, { id, titulo: informacoes.split(/\n/)[0], imagem_path: 'artes/foto.jpg' });
        return { matter: { id } };
      },
    },
    './materiaModelosService': {
      resolverModelo: async (m) => m || 'claude-sonnet-5',
      nomeModeloHumano: (m) => (m === 'gpt-5.6' ? 'ChatGPT 5.6' : m),
    },
    './tokenFreeGatewayService': { comModelo: (_m, fn) => fn() },
    './ntfyService': {
      SERVIDOR_PADRAO: 'https://ntfy.sh',
      enviar: async (aviso) => { eventos.avisos.push(aviso); },
      normalizarTopico: (t) => String(t || '').trim() || null,
      normalizarServidor: (v) => String(v || '').trim() || 'https://ntfy.sh',
    },
    '../config/env': { appPublicUrl: 'https://app.test' },
    './materiaChatService': {},
    './deepseekService': {
      usarTokenFree: () => gateway,
      ranquearPautasParaPublico: async () => avaliacoes || [],
    },
    './newsResearch': { titulosSimilares: (a, b) => a === b },
    './facebookPageResolver': { resolvePageForUser: async () => ({ id: 7 }), defaultPageForUser: async () => ({ id: 7 }) },
  };
  const filename = path.resolve(__dirname, '../src/services/furosAutopilotService.js');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, console, setTimeout, clearTimeout, setInterval, setImmediate, Date, URL,
    require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id)),
  }, { filename });
  /** Simula o agendador do sistema (tickFilaJobs): publica o que venceu. */
  const agendador = () => {
    for (const job of tabelas.ai_fila_jobs) {
      if (job.status !== 'pendente' || new Date(job.run_at).getTime() > Date.now()) continue;
      const matter = matters.get(Number(job.matter_id));
      if (!matter || matter.status !== 'agendado') continue;
      matter.status = 'publicado';
      job.status = 'feito';
      eventos.publicadas.push(Number(job.matter_id));
    }
  };
  const service = { ...module.exports, tick: async () => { await module.exports.tick(); agendador(); } };
  return { service, tabelas, eventos, matters, agendador };
}

const MANCHETES = [
  'Pastora condenada pelo 8 de janeiro deixa a prisão após dois anos',
  'Congresso recebe medida provisória que proíbe apostas esportivas',
  'Cantor gospel anuncia turnê nacional com vinte shows',
  'Polícia Federal prende suspeito de fraude em igreja no Pará',
  'Papa Leão XIV recebe líderes evangélicos no Vaticano',
  'Senado aprova aumento de penas para maus-tratos contra animais',
];

function naFila(tabelas, n, titulos = MANCHETES) {
  for (let i = 1; i <= n; i += 1) {
    const titulo = titulos[i - 1];
    tabelas.furos_autopilot_itens.push({
      id: i, user_id: 1, chave: `k${i}`, canal: 'noticias', titulo, url: `https://ex.test/${i}`,
      pauta: JSON.stringify({ titulo, url: `https://ex.test/${i}` }), score: 50 - i, nota_ia: 90 - i,
      status: 'na_fila', origem: 'auto', tentativas: 0, created_at: new Date(), updated_at: new Date(),
    });
  }
}

function avancarAteProximoAgendamento(ctx) {
  const pendentes = ctx.tabelas.furos_autopilot_itens
    .filter((i) => i.status === 'agendada')
    .sort((a, b) => new Date(a.agendado_para) - new Date(b.agendado_para));
  const proximo = pendentes[0];
  if (!proximo) return null;
  const job = ctx.tabelas.ai_fila_jobs.find((j) => j.matter_id === proximo.matter_id && j.status === 'pendente');
  if (job) job.run_at = new Date(Date.now() - 1000);
  return proximo;
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

test('agenda uma por intervalo (Agendado em Matérias salvas) e o agendador publica', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  naFila(ctx.tabelas, 4);
  await rodar(ctx.service, 20);
  // A primeira é agendada para já e sai; as outras ficam agendadas a cada 10 min.
  assert.equal(ctx.eventos.publicadas.length, 1);
  const agendadas = ctx.tabelas.furos_autopilot_itens.filter((i) => i.status === 'agendada')
    .sort((a, b) => new Date(a.agendado_para) - new Date(b.agendado_para));
  assert.ok(agendadas.length >= 2);
  const passo = new Date(agendadas[1].agendado_para) - new Date(agendadas[0].agendado_para);
  assert.equal(Math.round(passo / 60_000), 10);
  for (const item of agendadas) {
    const matter = ctx.matters.get(item.matter_id);
    assert.equal(matter.status, 'agendado');
    assert.equal(new Date(matter.scheduled_at).getTime(), new Date(item.agendado_para).getTime());
    assert.ok(ctx.tabelas.ai_fila_jobs.some((j) => j.matter_id === item.matter_id && j.status === 'pendente'));
  }
  // Chegou o horário da próxima: o agendador do sistema publica e o piloto marca.
  const proxima = avancarAteProximoAgendamento(ctx);
  await rodar(ctx.service, 3);
  assert.equal(ctx.eventos.publicadas.length, 2);
  assert.equal(ctx.tabelas.furos_autopilot_itens.find((i) => i.id === proxima.id).status, 'publicada');
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

test('não agenda duas vezes o mesmo assunto, mesmo vindo de veículos diferentes', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  naFila(ctx.tabelas, 3, [
    'Fux suspende decisão de Dino e retoma ordem contra fake news sobre Nossa Senhora',
    'Fux susta decisão de Dino sobre fake news de Nossa Senhora',
    'Congresso recebe medida provisória que proíbe apostas esportivas',
  ]);
  await rodar(ctx.service, 15);
  avancarAteProximoAgendamento(ctx);
  await rodar(ctx.service, 4);
  const porStatus = Object.fromEntries(ctx.tabelas.furos_autopilot_itens.map((i) => [i.id, i.status]));
  assert.equal(porStatus[1], 'publicada');
  assert.equal(porStatus[2], 'descartada');
  assert.match(ctx.tabelas.furos_autopilot_itens[1].erro, /não duplicar/);
  assert.equal(porStatus[3], 'publicada');
  assert.equal(ctx.eventos.publicadas.length, 2);
});

test('não republica matéria que já foi publicada (à mão ou por outro caminho)', async () => {
  const ctx = carregar({ imagem: () => esperar(120) });
  naFila(ctx.tabelas, 1);
  await rodar(ctx.service, 3);
  assert.equal(ctx.tabelas.furos_autopilot_itens[0].status, 'gerando_imagem');
  // Enquanto gerava a imagem, o editor publicou a mesma matéria à mão.
  for (const m of ctx.matters.values()) m.status = 'publicado';
  await rodar(ctx.service, 10);
  assert.equal(ctx.eventos.publicadas.length, 0);
  assert.equal(ctx.tabelas.furos_autopilot_itens[0].status, 'descartada');
  // O intervalo não foi gasto com a duplicata.
  assert.equal(ctx.tabelas.furos_autopilot[0].proxima_postagem_at, null);
});

test('não publica assunto que a conta já publicou por outro caminho', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  ctx.tabelas.ai_matters.push({
    id: 99, user_id: 1, status: 'publicado', updated_at: new Date(),
    titulo: 'Pastora condenada pelo 8/1 deixa prisão após mais de dois anos', fonte_url: 'https://outro.test/x',
  });
  naFila(ctx.tabelas, 1);
  await rodar(ctx.service, 12);
  assert.equal(ctx.eventos.publicadas.length, 0);
  assert.match(ctx.tabelas.furos_autopilot_itens[0].erro, /matéria #99/);
});

test('pausar guarda fila e configuração e não publica; retomar volta a publicar', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  naFila(ctx.tabelas, 1);
  const pausado = await ctx.service.pausar(1);
  assert.equal(pausado.config.ativo, false);
  assert.equal(pausado.config.existe, true);
  assert.ok(pausado.config.pausado_at);
  await rodar(ctx.service, 8);
  assert.equal(ctx.eventos.publicadas.length, 0);
  assert.equal(ctx.tabelas.furos_autopilot_itens[0].status, 'na_fila');
  assert.equal(ctx.tabelas.furos_autopilot[0].intervalo_minutos, 10);

  const retomado = await ctx.service.retomar(1);
  assert.equal(retomado.config.ativo, true);
  assert.equal(retomado.config.pausado_at, null);
  await rodar(ctx.service, 10);
  assert.equal(ctx.eventos.publicadas.length, 1);
});

test('página Piloto automático mostra pausado e retoma com confirmação', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/views/piloto-automatico.ejs'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/piloto-automatico' });
  const { window } = dom;
  const chamadas = [];
  window.confirm = () => true;
  const status = (ativo) => ({
    config: { existe: true, ativo, pausado_at: ativo ? null : new Date().toISOString(), intervalo_minutos: 10, limite_dia: 40 },
    contagens: { pronta: 1 }, publicadasHoje: 3, maxImagens: 2,
    itens: [{ id: 1, canal: 'youtube', titulo: 'Pastor reage', url: 'https://x.test', status: 'pronta', nota_ia: 70, imagem_ia: true }],
  });
  window.fetch = async (url, options = {}) => {
    chamadas.push(`${options.method || 'GET'} ${url}`);
    return { ok: true, status: 200, json: async () => status(url.endsWith('/retomar')) };
  };
  try {
    window.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/piloto-automatico.js'), 'utf8'));
    await esperar(20);
    const doc = window.document;
    assert.equal(doc.getElementById('piloto-titulo').textContent, 'Pausado');
    assert.equal(doc.getElementById('piloto-retomar').hidden, false);
    assert.equal(doc.getElementById('piloto-pausar').hidden, true);
    assert.equal(doc.getElementById('piloto-n-hoje').textContent, '3/40');
    doc.getElementById('piloto-retomar').click();
    await esperar(20);
    assert.ok(chamadas.includes('POST /api/materias-ia/chat-extras/furos/auto/retomar'));
    assert.equal(doc.getElementById('piloto-titulo').textContent, 'Ligado');
    assert.equal(doc.getElementById('piloto-pausar').hidden, false);
  } finally {
    window.close();
  }
});

test('fila vazia: as melhores da varredura entram mesmo com nota baixa, menos as zeradas', async () => {
  const furos = [
    { canal: 'noticias', titulo: 'Pastora condenada deixa a prisão após dois anos', url: 'https://ex.test/a', score: 30, resumo: '' },
    { canal: 'noticias', titulo: 'Congresso recebe MP que proíbe apostas', url: 'https://ex.test/b', score: 25, resumo: '' },
    { canal: 'noticias', titulo: 'Agenda de cultos da semana', url: 'https://ex.test/c', score: 10, resumo: '' },
  ];
  const avaliacoes = [
    { id: 'p1', potencial: 25, afinidade: 20, motivo: 'fato novo' },
    { id: 'p2', potencial: 22, afinidade: 10, motivo: 'política' },
    { id: 'p3', potencial: 5, afinidade: 0, motivo: 'agenda' },
  ];
  const ctx = carregar({ imagem: () => esperar(5), avaliacoes, furos });
  ctx.tabelas.furos_autopilot[0].ativo = false;
  await ctx.service.escanearAgora(1);
  await esperar(30);
  const porTitulo = Object.fromEntries(ctx.tabelas.furos_autopilot_itens.map((i) => [i.titulo, i.status]));
  assert.equal(porTitulo['Pastora condenada deixa a prisão após dois anos'], 'na_fila');
  assert.equal(porTitulo['Congresso recebe MP que proíbe apostas'], 'na_fila');
  assert.equal(porTitulo['Agenda de cultos da semana'], 'descartada');
  assert.match(ctx.tabelas.furos_autopilot[0].ultimo_scan_resumo, /3 novas, 2 aprovadas/);
});

test('notícia do Google News que não dá para ler é escrita pela apuração do título', async () => {
  const ctx = carregar({
    imagem: () => esperar(5),
    gerarFuro: async () => {
      const err = new Error('Não consegui extrair texto suficiente da notícia/post original.');
      err.status = 422;
      throw err;
    },
  });
  naFila(ctx.tabelas, 1);
  ctx.tabelas.furos_autopilot_itens[0].url = 'https://news.google.com/rss/articles/CBMi';
  await rodar(ctx.service, 10);
  assert.equal(ctx.eventos.apuradas, 1);
  assert.equal(ctx.eventos.publicadas.length, 1);
});

test('tentar de novo volta o item com erro para a fila', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  naFila(ctx.tabelas, 1);
  Object.assign(ctx.tabelas.furos_autopilot_itens[0], { status: 'erro', erro: 'Escrita: falhou' });
  ctx.tabelas.furos_autopilot[0].ativo = false;
  await ctx.service.refazerItem(1, 1);
  assert.equal(ctx.tabelas.furos_autopilot_itens[0].status, 'na_fila');
  assert.equal(ctx.tabelas.furos_autopilot_itens[0].erro, null);
});

test('notícia é escrita pelo caminho do chat com o modelo escolhido no /materia-manual', async () => {
  const ctx = carregar({ imagem: () => esperar(5), gateway: true });
  ctx.tabelas.furos_autopilot[0].modelo = 'gpt-5.6';
  naFila(ctx.tabelas, 1);
  await rodar(ctx.service, 8);
  assert.deepEqual(ctx.eventos.peloChat, [{ url: 'https://ex.test/1', modelo: 'gpt-5.6' }]);
  assert.equal(ctx.eventos.peloFuro || 0, 0);
  assert.equal(ctx.eventos.publicadas.length, 1);
  const status = await ctx.service.statusPainel(1);
  assert.equal(status.modeloNome, 'ChatGPT 5.6');
});

test('trocar o modelo no chat atualiza o piloto', async () => {
  const ctx = carregar({ imagem: () => esperar(5), gateway: true });
  ctx.tabelas.furos_autopilot[0].ativo = false;
  const status = await ctx.service.salvarModelo(1, 'gpt-5.6');
  assert.equal(ctx.tabelas.furos_autopilot[0].modelo, 'gpt-5.6');
  assert.equal(status.modeloNome, 'ChatGPT 5.6');
});

test('painel: mudar o modelo no chat avisa o piloto (e ignora o carregamento)', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/views/materia-manual.ejs'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/materia-manual' });
  const { window } = dom;
  const trocas = [];
  window.fetch = async (url, options = {}) => {
    if (url.endsWith('/furos/auto/modelo')) trocas.push(JSON.parse(options.body).modelo);
    return {
      ok: true, status: 200,
      json: async () => ({ config: { existe: true, ativo: true, intervalo_minutos: 10, limite_dia: 40 }, contagens: {}, itens: [], modeloNome: 'ChatGPT 5.6' }),
    };
  };
  try {
    window.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/materia-furos-auto.js'), 'utf8'));
    await esperar(20);
    const seletor = window.document.getElementById('chat-ai-model');
    seletor.dataset.modelo = 'claude-sonnet-5';
    window.document.dispatchEvent(new window.CustomEvent('materia:modelo-alterado')); // carregamento
    seletor.dataset.modelo = 'gpt-5.6';
    window.document.dispatchEvent(new window.CustomEvent('materia:modelo-alterado')); // editor trocou
    await esperar(20);
    assert.deepEqual(trocas, ['gpt-5.6']);
  } finally {
    window.close();
  }
});

test('varredura do piloto é leve e é pulada com a fila cheia', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  const row = ctx.tabelas.furos_autopilot[0];
  row.ultimo_scan_at = null;
  await ctx.service.escanearAgora(1);
  await esperar(20);
  // Sem procurar link real e foto de cada pauta (isso fica para a que for escrita).
  assert.equal(ctx.eventos.buscas.length, 1);
  assert.equal(ctx.eventos.buscas[0].completar, false);

  // Com 4 pautas esperando, a varredura normal é adiada.
  row.ativo = false;
  naFila(ctx.tabelas, 4);
  row.ativo = true;
  row.ultimo_scan_at = null;
  row.proxima_postagem_at = new Date(Date.now() + 3_600_000);
  await ctx.service.tick();
  await esperar(30);
  assert.equal(ctx.eventos.buscas.length, 1);
  assert.match(String(row.ultimo_scan_resumo), /já esperando na fila; varredura adiada/);
});

test('painel só lista os últimos 3 dias e apaga recusadas antigas', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  const antigo = new Date(Date.now() - 20 * 24 * 3_600_000);
  ctx.tabelas.furos_autopilot_itens.push(
    { id: 1, user_id: 1, chave: 'a', canal: 'noticias', titulo: 'Velha publicada', url: 'u', status: 'publicada', score: 1, created_at: antigo, updated_at: antigo },
    { id: 2, user_id: 1, chave: 'b', canal: 'noticias', titulo: 'Recusada antiga', url: 'u', status: 'descartada', score: 1, created_at: antigo, updated_at: antigo },
    { id: 3, user_id: 1, chave: 'c', canal: 'noticias', titulo: 'Nova publicada', url: 'u', status: 'publicada', score: 1, created_at: new Date(), updated_at: new Date() },
  );
  const status = await ctx.service.statusPainel(1);
  assert.deepEqual(status.itens.map((i) => i.titulo), ['Nova publicada']);
  await ctx.service.tick();
  await esperar(20);
  assert.ok(!ctx.tabelas.furos_autopilot_itens.some((i) => i.titulo === 'Recusada antiga'));
});

const PAUTAS_ESCOLHIDAS = [
  { canal: 'noticias', titulo: 'Pastora condenada pelo 8 de janeiro deixa a prisão após dois anos', url: 'https://ex.test/m1', score: 30 },
  { canal: 'noticias', titulo: 'Congresso recebe medida provisória que proíbe apostas esportivas', url: 'https://ex.test/m2', score: 20 },
];

test('fila escolhida: com o Automatizar desligado, escreve, gera imagem e AGENDA no intervalo escolhido', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  Object.assign(ctx.tabelas.furos_autopilot[0], { ativo: false, proxima_postagem_at: null });
  const r = await ctx.service.enfileirarEscolhidas(1, { pautas: PAUTAS_ESCOLHIDAS, intervalo_minutos: 5, facebook_page_id: 7 });
  assert.equal(r.adicionadas.length, 2);
  assert.ok(ctx.tabelas.furos_autopilot_itens.every((i) => i.origem === 'manual'));
  await rodar(ctx.service, 15);
  // As duas ficam agendadas (5 min de diferença); a primeira já saiu.
  const itens = ctx.tabelas.furos_autopilot_itens;
  assert.equal(ctx.eventos.publicadas.length, 1);
  const segunda = itens.find((i) => i.status === 'agendada');
  assert.ok(segunda);
  assert.equal(ctx.matters.get(segunda.matter_id).status, 'agendado');
  const primeira = itens.find((i) => i.status === 'publicada');
  const passo = new Date(segunda.agendado_para) - new Date(ctx.tabelas.ai_fila_jobs.find((j) => j.matter_id === primeira.matter_id).run_at);
  assert.equal(Math.round(passo / 60_000), 5);
  assert.equal(ctx.tabelas.furos_autopilot[0].ativo, false);
  avancarAteProximoAgendamento(ctx);
  await rodar(ctx.service, 4);
  assert.equal(ctx.eventos.publicadas.length, 2);
  assert.ok(itens.every((i) => i.status === 'publicada' && i.imagem_ia === true));
  // Sem varredura: nada de busca com o Automatizar desligado.
  assert.equal((ctx.eventos.buscas || []).length, 0);
});

test('pausado: só anda o que o editor escolheu; as pautas da IA esperam', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  ctx.tabelas.furos_autopilot[0].ativo = false;
  naFila(ctx.tabelas, 1); // escolhida pela IA (origem auto)
  ctx.tabelas.furos_autopilot_itens[0].origem = 'auto';
  await ctx.service.enfileirarEscolhidas(1, { pautas: [PAUTAS_ESCOLHIDAS[1]], intervalo_minutos: 10, facebook_page_id: 7 });
  await rodar(ctx.service, 15);
  const porOrigem = Object.fromEntries(ctx.tabelas.furos_autopilot_itens.map((i) => [i.origem, i.status]));
  assert.equal(porOrigem.manual, 'publicada');
  assert.equal(porOrigem.auto, 'na_fila');
});

test('cancelar a fila no meio da imagem não traz a pauta de volta', async () => {
  const ctx = carregar({ imagem: () => esperar(120) });
  ctx.tabelas.furos_autopilot[0].ativo = false;
  await ctx.service.enfileirarEscolhidas(1, { pautas: [PAUTAS_ESCOLHIDAS[0]], intervalo_minutos: 10, facebook_page_id: 7 });
  await rodar(ctx.service, 3);
  assert.equal(ctx.tabelas.furos_autopilot_itens[0].status, 'gerando_imagem');
  await ctx.service.cancelarFilaManual(1);
  await esperar(200);
  await rodar(ctx.service, 3);
  assert.equal(ctx.tabelas.furos_autopilot_itens[0].status, 'descartada');
  assert.equal(ctx.eventos.publicadas.length, 0);
});

test('pauta já publicada pelo piloto não entra de novo na fila escolhida', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  const chave = ctx.service.chaveDaPauta(PAUTAS_ESCOLHIDAS[0]);
  ctx.tabelas.furos_autopilot_itens.push({ id: 1, user_id: 1, chave, canal: 'noticias', titulo: 'x', url: 'u', status: 'publicada', score: 1, created_at: new Date(), updated_at: new Date() });
  const r = await ctx.service.enfileirarEscolhidas(1, { pautas: [PAUTAS_ESCOLHIDAS[0]], intervalo_minutos: 10, facebook_page_id: 7 });
  assert.equal(r.adicionadas.length, 0);
  assert.match(r.ignoradas[0].motivo, /já foi publicada/);
});

test('Furos: "Publicar 1 a cada 5 min" manda as marcadas para a fila e acompanha até publicar', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/views/materia-manual.ejs'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/materia-manual' });
  const { window } = dom;
  window.confirm = () => true;
  const pedidos = [];
  let consultasStatus = 0;
  const pauta = { canal: 'noticias', titulo: 'Fato novo', url: 'https://ex.test/f', score: 30, motivos: [] };
  window.fetch = async (url, options = {}) => {
    if (options.body) pedidos.push({ url, corpo: JSON.parse(options.body) });
    let data = {};
    if (url.endsWith('/furos/nichos')) data = { nichos: [], sugeridos: [] };
    else if (url.endsWith('/furos/buscar')) data = { furos: [pauta], nichos: [], horas: 24 };
    else if (url.includes('/api/facebook/pages')) data = { pages: [{ id: 7, page_name: 'JM Notícia' }], default_facebook_page_id: 7 };
    else if (url.endsWith('/furos/auto/fila')) data = { adicionadas: [{ id: 42, url: pauta.url, titulo: pauta.titulo }], ignoradas: [] };
    else if (url.endsWith('/furos/auto')) {
      consultasStatus += 1;
      data = { config: { existe: true }, itens: [{ id: 42, status: 'publicada', publicado_at: new Date().toISOString(), matter_id: 9 }] };
    }
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    window.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/materia-furos.js'), 'utf8'));
    const doc = window.document;
    doc.querySelector('.mia-furos-open').click();
    await esperar(20);
    doc.getElementById('furos-destino').value = '5';
    doc.getElementById('furos-destino').dispatchEvent(new window.Event('change'));
    doc.getElementById('furos-buscar').click();
    await esperar(20);
    doc.querySelector('.mia-furo-check').checked = true;
    doc.querySelector('.mia-furo-check').dispatchEvent(new window.Event('change'));
    assert.match(doc.getElementById('furos-gerar').textContent, /Gerar e publicar 1 matéria/);
    doc.getElementById('furos-gerar').click();
    await esperar(40);
    const fila = pedidos.find((p) => p.url.endsWith('/furos/auto/fila'));
    assert.equal(fila.corpo.intervalo_minutos, 5);
    assert.equal(fila.corpo.facebook_page_id, '7');
    assert.equal(fila.corpo.pautas[0].url, pauta.url);
    assert.ok(consultasStatus >= 1);
    assert.match(doc.querySelector('.mia-furo-resultado').textContent, /Publicada às/);
  } finally {
    window.close();
  }
});

test('pausar desfaz os agendamentos da IA que ainda não saíram; cancelar a fila desfaz os escolhidos', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  naFila(ctx.tabelas, 3);
  await rodar(ctx.service, 15);
  const agendadaIa = ctx.tabelas.furos_autopilot_itens.find((i) => i.status === 'agendada');
  assert.ok(agendadaIa);
  await ctx.service.pausar(1);
  assert.equal(agendadaIa.status, 'pronta');
  assert.equal(ctx.matters.get(agendadaIa.matter_id).status, 'rascunho');
  assert.ok(!ctx.tabelas.ai_fila_jobs.some((j) => j.matter_id === agendadaIa.matter_id && j.status === 'pendente'));

  await ctx.service.enfileirarEscolhidas(1, {
    pautas: [
      { canal: 'noticias', titulo: 'Prefeitura anuncia mutirão de vacinação no fim de semana', url: 'https://ex.test/v1', score: 30 },
      { canal: 'noticias', titulo: 'Seleção feminina vence amistoso e garante vaga no torneio', url: 'https://ex.test/v2', score: 20 },
    ],
    intervalo_minutos: 5,
    facebook_page_id: 7,
  });
  await rodar(ctx.service, 15);
  const escolhidaAgendada = ctx.tabelas.furos_autopilot_itens.find((i) => i.origem === 'manual' && i.status === 'agendada');
  assert.ok(escolhidaAgendada);
  await ctx.service.cancelarFilaManual(1);
  assert.equal(escolhidaAgendada.status, 'descartada');
  assert.equal(ctx.matters.get(escolhidaAgendada.matter_id).status, 'rascunho');
});

test('ntfy: o piloto avisa a falha antes de publicar (imagem), com o motivo', async () => {
  const ctx = carregar({ imagem: async () => { throw new Error('ChatGPT fora do ar'); } });
  Object.assign(ctx.tabelas.furos_autopilot[0], { ntfy_topico: 'viralizeai-teste1', ntfy_publicada: true, ntfy_falha: true, foto_original_se_falhar: false });
  naFila(ctx.tabelas, 1);
  await rodar(ctx.service, 25);
  await esperar(20);
  const item = ctx.tabelas.furos_autopilot_itens[0];
  assert.equal(item.status, 'erro');
  assert.equal(ctx.eventos.avisos.length, 1, 'um aviso só');
  const aviso = ctx.eventos.avisos[0];
  assert.equal(aviso.titulo, 'Não publicada · Gospel Geral');
  assert.equal(aviso.topico, 'viralizeai-teste1');
  assert.match(aviso.mensagem, /Motivo: Sem imagem: ChatGPT fora do ar/);
  assert.equal(aviso.tags.join(','), 'x');
  assert.match(aviso.clique, /^https:\/\/app\.test\/materias-ia\/\d+$/);
});

test('ntfy: publicada e falha no envio ficam com o aviso geral da matéria (sem duplicar)', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  Object.assign(ctx.tabelas.furos_autopilot[0], { ntfy_topico: 'viralizeai-teste2', ntfy_publicada: true, ntfy_falha: true });
  naFila(ctx.tabelas, 2);
  await rodar(ctx.service, 20);
  assert.ok(ctx.tabelas.furos_autopilot_itens.some((i) => i.status === 'publicada'));
  const agendada = ctx.tabelas.furos_autopilot_itens.find((i) => i.status === 'agendada');
  const job = ctx.tabelas.ai_fila_jobs.find((j) => j.matter_id === agendada.matter_id && j.status === 'pendente');
  Object.assign(job, { status: 'erro', erro: 'Token da página expirou' });
  await rodar(ctx.service, 2);
  await esperar(20);
  assert.equal(agendada.status, 'erro');
  assert.equal(ctx.eventos.avisos.length, 0);
});

test('ntfy: sem tópico ou com o aviso de falha desmarcado, o piloto não manda nada', async () => {
  const falhaDesmarcada = carregar({ imagem: async () => { throw new Error('falhou'); } });
  Object.assign(falhaDesmarcada.tabelas.furos_autopilot[0], { ntfy_topico: 'viralizeai-teste3', ntfy_falha: false, foto_original_se_falhar: false });
  naFila(falhaDesmarcada.tabelas, 1);
  await rodar(falhaDesmarcada.service, 25);
  await esperar(20);
  assert.equal(falhaDesmarcada.tabelas.furos_autopilot_itens[0].status, 'erro');
  assert.equal(falhaDesmarcada.eventos.avisos.length, 0);

  const semTopico = carregar({ imagem: async () => { throw new Error('falhou'); } });
  Object.assign(semTopico.tabelas.furos_autopilot[0], { foto_original_se_falhar: false });
  naFila(semTopico.tabelas, 1);
  await rodar(semTopico.service, 25);
  await esperar(20);
  assert.equal(semTopico.eventos.avisos.length, 0);
});

test('ntfy: salvar guarda tópico e token sem devolver o token ao navegador', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  const s = await ctx.service.salvarNtfy(1, { topico: 'viralizeai-abc123', token: 'tk_segredo', publicada: true, falha: false });
  assert.equal(s.config.ntfy.topico, 'viralizeai-abc123');
  assert.equal(s.config.ntfy.token_definido, true);
  assert.equal(s.config.ntfy.falha, false);
  assert.ok(!JSON.stringify(s).includes('tk_segredo'));
  assert.equal(ctx.tabelas.furos_autopilot[0].ntfy_token, 'tk_segredo');
  // Salvar de novo sem token mantém o que estava.
  await ctx.service.salvarNtfy(1, { topico: 'viralizeai-abc123', publicada: true, falha: true });
  assert.equal(ctx.tabelas.furos_autopilot[0].ntfy_token, 'tk_segredo');
  await ctx.service.testarNtfy(1);
  assert.equal(ctx.eventos.avisos.at(-1).titulo, 'ViralizeAI · teste');
});

function periodo(deMin, ateMin) {
  return JSON.stringify({
    modo: 'periodo',
    inicio_at: new Date(Date.now() + deMin * 60_000).toISOString(),
    fim_at: new Date(Date.now() + ateMin * 60_000).toISOString(),
  });
}

test('agenda: fora do horário não varre nem escreve as da IA, mas a fila escolhida anda', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  Object.assign(ctx.tabelas.furos_autopilot[0], { agenda: periodo(120, 300), ultimo_scan_at: null });
  naFila(ctx.tabelas, 2);
  await ctx.service.enfileirarEscolhidas(1, {
    pautas: [{ canal: 'noticias', titulo: 'Prefeitura anuncia mutirão de vacinação no fim de semana', url: 'https://ex.test/v1', score: 30 }],
    intervalo_minutos: 10,
    facebook_page_id: 7,
  });
  await rodar(ctx.service, 15);
  assert.equal((ctx.eventos.buscas || []).length, 0, 'não varre fora do horário');
  const daIa = ctx.tabelas.furos_autopilot_itens.filter((i) => i.origem === 'auto');
  assert.ok(daIa.every((i) => i.status === 'na_fila'), 'as da IA esperam o horário');
  const escolhida = ctx.tabelas.furos_autopilot_itens.find((i) => i.origem === 'manual');
  assert.equal(escolhida.status, 'publicada');
  assert.equal(ctx.tabelas.furos_autopilot[0].ativo, true, 'o Automatizar continua ligado');
  const painel = await ctx.service.statusPainel(1);
  assert.equal(painel.agenda.dentro, false);
  assert.match(painel.agenda.frase, /fora do horário · começa/);
});

test('agenda: não agenda as da IA depois do fim da janela', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  // Janela fecha em 15 min; posta a cada 10 min: cabem 2 (agora e +10).
  Object.assign(ctx.tabelas.furos_autopilot[0], { agenda: periodo(-60, 15) });
  naFila(ctx.tabelas, 4);
  await rodar(ctx.service, 25);
  const saidas = ctx.tabelas.furos_autopilot_itens.filter((i) => ['agendada', 'publicada'].includes(i.status));
  assert.equal(saidas.length, 2);
  assert.ok(ctx.tabelas.furos_autopilot_itens.some((i) => i.status === 'pronta'), 'o resto fica pronto para a próxima janela');
});

test('agenda: período encerrado desliga o piloto sozinho', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  Object.assign(ctx.tabelas.furos_autopilot[0], { agenda: periodo(-300, -60) });
  naFila(ctx.tabelas, 1);
  await rodar(ctx.service, 3);
  const cfg = ctx.tabelas.furos_autopilot[0];
  assert.equal(cfg.ativo, false);
  assert.ok(cfg.pausado_at);
  assert.match(cfg.ultimo_scan_resumo, /Período da agenda terminou/);
  assert.equal(ctx.eventos.publicadas.length, 0);
});

test('agenda: salvar valida e guarda; sem o campo mantém a agenda salva', async () => {
  const ctx = carregar({ imagem: () => esperar(5) });
  const base = { ativo: true, intervalo_minutos: 10, limite_dia: 40, facebook_page_id: 7, nichos: ['auto'], canais: ['noticias'] };
  await assert.rejects(
    ctx.service.salvarConfig(1, { ...base, agenda: { modo: 'diario', horario_inicio: '07:00', horario_fim: '07:00' } }),
    /iguais/
  );
  await ctx.service.salvarConfig(1, { ...base, agenda: { modo: 'diario', horario_inicio: '07:00', horario_fim: '23:00' } });
  assert.equal(JSON.parse(ctx.tabelas.furos_autopilot[0].agenda).horario_fim, '23:00');
  const s = await ctx.service.salvarConfig(1, base);
  assert.equal(s.config.agenda.modo, 'diario');
});
