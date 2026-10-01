const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

/** Banco mínimo: where(...).first(...) e update(...) por tabela. */
function criarDb(tabelas) {
  const db = (tabela) => {
    let filtro = () => true;
    const q = {
      where(cond) { filtro = (r) => Object.entries(cond).every(([k, v]) => r[k] === v); return q; },
      async first() { const r = (tabelas[tabela] || []).find(filtro); return r ? { ...r } : undefined; },
      async update(dados) {
        const alvo = (tabelas[tabela] || []).filter(filtro);
        for (const r of alvo) Object.assign(r, dados);
        return alvo.length;
      },
    };
    return q;
  };
  db.fn = { now: () => new Date() };
  return db;
}

const tabelas = {
  ai_matters: [],
  furos_autopilot: [],
  facebook_pages: [{ id: 7, page_name: 'Gospel Geral' }],
  publications: [{ id: 50, fb_post_url: 'https://facebook.com/7/posts/123' }],
};
const enviados = [];

const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');

/** Carrega um módulo do projeto com dependências trocadas, sem mexer no cache global. */
function carregarCom(relativo, mocks) {
  const filename = path.resolve(__dirname, '..', relativo);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, console, setTimeout, clearTimeout, setImmediate, Date, URL,
    require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id)),
  }, { filename });
  return module.exports;
}

const db = criarDb(tabelas);
const modelos = {};
const avisoPublicacao = carregarCom('src/services/avisoPublicacao.js', {
  '../config/db': db,
  '../config/env': { appPublicUrl: 'https://www.viralizeai.online' },
  './ntfyService': { enviar: async (aviso) => { enviados.push(aviso); } },
  '../models/AiMatters': { findById: (id) => modelos.AiMatters.findById(id) },
});
modelos.AiMatters = carregarCom('src/models/AiMatters.js', {
  '../config/db': db,
  '../services/avisoPublicacao': avisoPublicacao,
});
const AiMatters = modelos.AiMatters;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function reset({ ntfy = {} } = {}) {
  enviados.length = 0;
  tabelas.ai_matters = [
    { id: 1, user_id: 3, titulo: 'Pastor **anuncia** culto especial', status: 'agendado', facebook_page_id: 7, publication_id: 50 },
    { id: 2, user_id: 3, titulo: 'Matéria manual', status: 'pronto', facebook_page_id: 7, publication_id: null },
  ];
  tabelas.furos_autopilot = [{ user_id: 3, ntfy_topico: 'viralizeai-abc123', ntfy_publicada: true, ntfy_falha: true, ...ntfy }];
}

test('qualquer matéria publicada avisa no ntfy, com link do post no Facebook', async () => {
  reset();
  await AiMatters.update(1, { status: 'publicado', published_at: new Date() });
  await esperar(20);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].titulo, 'Publicada · Gospel Geral');
  assert.equal(enviados[0].mensagem, 'Pastor anuncia culto especial');
  assert.equal(enviados[0].clique, 'https://facebook.com/7/posts/123');
  assert.equal(enviados[0].topico, 'viralizeai-abc123');
});

test('não avisa de novo se a matéria já estava publicada', async () => {
  reset();
  tabelas.ai_matters[0].status = 'publicado';
  await AiMatters.update(1, { status: 'publicado' });
  await esperar(20);
  assert.equal(enviados.length, 0);
});

test('falha ao publicar avisa "Não publicada" com o motivo e o link da matéria', async () => {
  reset();
  await AiMatters.update(2, { status: 'erro', error_message: 'Token da página expirou' });
  await esperar(20);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].titulo, 'Não publicada · Gospel Geral');
  assert.match(enviados[0].mensagem, /Motivo: Token da página expirou/);
  assert.equal(enviados[0].clique, 'https://www.viralizeai.online/materias-ia/2');
});

test('respeita as opções: sem tópico ou com "publicada" desmarcada não manda', async () => {
  reset({ ntfy: { ntfy_publicada: false } });
  await AiMatters.update(1, { status: 'publicado' });
  reset({ ntfy: { ntfy_topico: null } });
  await AiMatters.update(1, { status: 'publicado' });
  await esperar(20);
  assert.equal(enviados.length, 0);
});

test('outras mudanças (rascunho, agendado, título) não avisam', async () => {
  reset();
  await AiMatters.update(2, { status: 'agendado', scheduled_at: new Date() });
  await AiMatters.update(2, { titulo: 'Novo título' });
  await esperar(20);
  assert.equal(enviados.length, 0);
});
