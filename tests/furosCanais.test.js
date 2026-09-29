const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sociais = require('../src/services/furosSociais');
const { pontuarBomba } = require('../src/services/furosService');

test('lê visualizações, idade e duração no formato do YouTube em português', () => {
  assert.deepEqual(
    ['410.330 visualizações', '12 mil visualizações', '1,2 mi de visualizações', 'Nenhuma visualização'].map(sociais.numeroDeViews),
    [410330, 12000, 1200000, 0]
  );
  assert.deepEqual(['há 23 h', 'há 2 horas', 'há 30 minutos', 'há 3 dias'].map(sociais.horasAtras), [23, 2, 0.5, 72]);
  assert.equal(Math.round(sociais.duracaoMinutos('1:10:08')), 70);
});

test('alcance real sobe a nota do vídeo e aparece nos motivos', () => {
  const agora = Date.now();
  const comViews = sociais.pontuarSocial({ titulo: 'Decisão no STF', views: 410_330, dataTimestamp: agora }, pontuarBomba, agora);
  const semViews = sociais.pontuarSocial({ titulo: 'Decisão no STF', views: 0, dataTimestamp: agora }, pontuarBomba, agora);
  assert.ok(comViews.score > semViews.score);
  assert.equal(comViews.motivos[0], '410 mil views');
});

test('painel envia fontes e quantidade e acompanha o vídeo até virar rascunho', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/views/materia-manual.ejs'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/materia-manual' });
  const { window } = dom;
  const pedidos = [];
  let consultas = 0;
  const pauta = { canal: 'youtube', titulo: 'Pastor reage', url: 'https://www.youtube.com/watch?v=abc', score: 40, motivos: [] };
  window.fetch = async (url, options = {}) => {
    const corpo = options.body ? JSON.parse(options.body) : null;
    pedidos.push({ url, corpo });
    let status = 200;
    let data = { ok: true };
    if (url.endsWith('/furos/nichos')) data = { nichos: [{ id: 'pastores', rotulo: 'Pastores' }], sugeridos: [] };
    else if (url.endsWith('/furos/buscar')) data = { furos: [pauta], nichos: [], horas: 24, porCanal: { youtube: 1 } };
    else if (url.endsWith('/furos/gerar')) { status = 202; data = { jobId: 'j1', estado: 'gerando' }; }
    else if (url.includes('/furos/gerar/j1')) {
      consultas += 1;
      data = consultas > 1
        ? { estado: 'ok', matterId: 9, redirect: '/materias-ia/9' }
        : { estado: 'gerando', etapa: 'Transcrevendo o áudio…' };
      status = data.estado === 'ok' ? 200 : 202;
    }
    return { ok: status < 300, status, json: async () => data };
  };
  try {
    window.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/materia-furos.js'), 'utf8'));
    const doc = window.document;
    doc.querySelector('.mia-furos-open').click();
    await new Promise((r) => setImmediate(r));
    // Desliga o Facebook e escolhe 40 pautas.
    doc.querySelector('[data-furos-canal="facebook"]').click();
    doc.getElementById('furos-limite').value = '40';
    doc.getElementById('furos-buscar').click();
    await new Promise((r) => setTimeout(r, 20));
    const busca = pedidos.find((p) => p.url.endsWith('/furos/buscar')).corpo;
    assert.equal(busca.limite, 40);
    assert.deepEqual(busca.canais.sort(), ['instagram', 'noticias', 'youtube']);
    assert.match(doc.querySelector('.mia-furo-canal').textContent, /YouTube/);

    doc.querySelector('.mia-furo-check').checked = true;
    doc.querySelector('.mia-furo-check').dispatchEvent(new window.Event('change'));
    doc.getElementById('furos-gerar').click();
    // O painel consulta a cada 3 s: espera duas voltas.
    await new Promise((r) => setTimeout(r, 6500));
    assert.equal(consultas, 2);
    assert.match(doc.querySelector('.mia-furo-resultado a').textContent, /Rascunho #9/);
  } finally {
    window.close();
  }
});
