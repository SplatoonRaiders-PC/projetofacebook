const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('Em alta: cada pauta tem "Publicar", que manda para a fila e mostra as etapas até publicar', async () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.resolve(__dirname, '../public/views/materia-manual.ejs'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/materia-manual' });
  const { window } = dom;
  const pedidos = [];
  let consultasStatus = 0;
  const topicos = [
    { titulo: 'Pesquisa: casais que frequentam igreja são mais felizes', url: 'https://guiame.test/casais', veiculo: 'Guiame', tema: 'Família', imagem: 'https://guiame.test/foto.jpg' },
    { titulo: 'Cinema de fé aposta nas comunidades', url: 'https://telaviva.test/cinema', veiculo: 'TELA VIVA', tema: 'Israel' },
  ];
  window.fetch = async (url, options = {}) => {
    const corpo = options.body ? JSON.parse(options.body) : null;
    pedidos.push({ url, metodo: options.method || 'GET', corpo });
    let data = { ok: true };
    if (url.endsWith('/em-alta')) data = { origem: 'em-alta', topicos, temas: [], horas: 168 };
    else if (url.endsWith('/api/facebook/pages')) data = { pages: [{ id: 7, page_name: 'JM Notícia' }], default_facebook_page_id: 7 };
    else if (url.endsWith('/furos/auto/fila')) data = { adicionadas: [{ id: 31, url: corpo.pautas[0].url }], ignoradas: [] };
    else if (url.endsWith('/furos/auto')) {
      consultasStatus += 1;
      const etapas = [
        { status: 'gerando_imagem' },
        { status: 'agendada', agendado_para: '2026-10-01T15:20:00Z' },
        { status: 'publicada', publicado_at: '2026-10-01T15:20:30Z', matter_id: 501 },
      ];
      data = { itens: [{ id: 31, ...etapas[Math.min(consultasStatus - 1, 2)] }], foraDaFila: [] };
    } else data = {};
    const texto = JSON.stringify(data);
    return { ok: true, status: 200, text: async () => texto, json: async () => data };
  };
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // Acelera as consultas de acompanhamento (4 s / 10 s) para o teste.
  const timeoutOriginal = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => timeoutOriginal(fn, Math.min(Number(ms) || 0, 20), ...args);
  try {
    window.eval(fs.readFileSync(path.resolve(__dirname, '../public/js/materia-chat-extras.js'), 'utf8'));
    const doc = window.document;
    doc.querySelector('.mia-x-alta-btn').click();
    await esperar(50);

    const botoes = doc.querySelectorAll('.mia-x-card-publicar');
    assert.equal(botoes.length, 2, 'um "Publicar" por pauta');
    botoes[0].click();
    await esperar(30);

    const fila = pedidos.find((p) => p.url.endsWith('/furos/auto/fila'));
    assert.equal(fila.metodo, 'POST');
    assert.equal(fila.corpo.pautas.length, 1);
    assert.equal(fila.corpo.pautas[0].url, 'https://guiame.test/casais');
    assert.equal(fila.corpo.pautas[0].imagem, 'https://guiame.test/foto.jpg');
    assert.equal(fila.corpo.facebook_page_id, '7');
    assert.equal(botoes[0].disabled, true);

    const card = botoes[0].closest('.mia-x-card');
    const linha = () => card.querySelector('.mia-x-card-fila');
    const vistas = new Set();
    for (let i = 0; i < 30 && !/Publicada/.test(linha()?.textContent || ''); i += 1) {
      if (linha()) vistas.add(linha().textContent);
      await esperar(15);
    }
    assert.ok([...vistas].some((t) => /imagem/i.test(t)), 'mostra a etapa da imagem');
    assert.ok([...vistas].some((t) => /Agendada para/.test(t)), 'mostra o horário agendado');
    assert.match(linha().textContent, /Publicada às/);
    assert.equal(linha().querySelector('a').getAttribute('href'), '/materias-ia/501');
    assert.ok(card.classList.contains('is-publicada'));
    // O outro card continua livre para publicar.
    assert.equal(botoes[1].disabled, false);
  } finally {
    window.close();
  }
});
