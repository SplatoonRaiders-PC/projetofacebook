const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const chamadas = { temas: null, consultasSociais: null, portaisNichos: null };

function falsificar(relativo, exportacoes) {
  const arquivo = require.resolve(path.join(__dirname, '..', relativo));
  require.cache[arquivo] = { id: arquivo, filename: arquivo, loaded: true, exports: exportacoes };
}

const agora = Date.now();
falsificar('src/routes/materiaChatExtras.js', {
  async radarPorTemas(temas) {
    chamadas.temas = temas;
    const tema = temas[0].rotulo;
    return {
      totalAnalisado: 3,
      topicos: [
        { tema, titulo: 'Silas Malafaia rebate críticas de deputado', link: 'https://ex.test/1', dataTimestamp: agora },
        { tema, titulo: 'Malafaia faz culto em São Paulo', link: 'https://ex.test/2', dataTimestamp: agora },
        { tema, titulo: 'Silas Malafaia anuncia evento com pastores', link: 'https://ex.test/3', dataTimestamp: agora },
      ],
    };
  },
});
falsificar('src/services/furosSociais.js', {
  async buscarFurosSociais({ consultas }) {
    chamadas.consultasSociais = consultas;
    return {
      itens: [
        { canal: 'instagram', titulo: 'Post sobre receita de bolo', url: 'https://ig.test/a', score: 50, dataTimestamp: agora },
        { canal: 'instagram', titulo: 'Silas Malafaia comenta decisão do STF', url: 'https://ig.test/b', score: 40, dataTimestamp: agora },
      ],
      avisos: [],
    };
  },
});
falsificar('src/services/portaisNichoService.js', {
  async buscarNosPortais({ nichos }) {
    chamadas.portaisNichos = nichos;
    return { itens: [], status: [] };
  },
});
falsificar('src/services/newsResearch.js', { titulosSimilares: (a, b) => a === b });
falsificar('src/models/AiMatters.js', { async findByUser() { return []; } });

const furos = require('../src/services/furosService');

test('lê as palavras-chave de texto com vírgulas, sem repetir e no máximo 5', () => {
  assert.deepEqual(
    furos.palavrasValidas('Silas Malafaia, "Lagoinha"; malafaia, x, a1, b2'),
    ['Silas Malafaia', 'Lagoinha', 'malafaia', 'a1', 'b2']
  );
  assert.deepEqual(furos.palavrasValidas(['  André   Valadão ', 'André Valadão']), ['André Valadão']);
});

test('com Automático e palavra-chave, a busca fica só na palavra e exige todos os termos', async () => {
  const r = await furos.buscarFuros({ userId: 1, nichos: ['auto'], palavras: 'Silas Malafaia', limite: 10, completar: false });
  assert.deepEqual(r.palavras, ['Silas Malafaia']);
  assert.deepEqual(r.nichos, []);
  assert.equal(r.automatico, false);
  assert.equal(chamadas.temas.length, 1);
  assert.deepEqual(chamadas.temas[0].consultas, ['"Silas Malafaia"']);
  assert.ok(chamadas.consultasSociais.every((c) => c.nicho === 'Silas Malafaia'));
  // Portais: lê todos e filtra pela palavra.
  assert.ok(chamadas.portaisNichos.length >= 4);
  const titulos = r.furos.map((f) => f.titulo);
  // Post das páginas monitoradas que não cita a palavra fica de fora.
  assert.ok(!titulos.includes('Post sobre receita de bolo'));
  assert.ok(titulos.includes('Silas Malafaia comenta decisão do STF'));
  // As que citam os dois termos vêm primeiro (são "do assunto").
  assert.ok(titulos.includes('Silas Malafaia rebate críticas de deputado'));
});

test('com nichos marcados, a palavra-chave soma aos nichos', async () => {
  const r = await furos.buscarFuros({ userId: 1, nichos: ['pastores'], palavras: ['Lagoinha'], limite: 10, completar: false });
  assert.deepEqual(r.palavras, ['Lagoinha']);
  assert.deepEqual(r.nichos.map((n) => n.id), ['pastores']);
  assert.deepEqual(chamadas.temas.map((t) => t.consultas[0]), ['Lagoinha', chamadas.temas[1].consultas[0]]);
  assert.equal(chamadas.temas[1].rotulo, 'Pastores');
  assert.deepEqual(chamadas.portaisNichos, ['pastores']);
});

test('sem nicho e sem palavra-chave continua usando o Automático', async () => {
  const r = await furos.buscarFuros({ userId: 1, nichos: [], palavras: '', limite: 5, completar: false });
  assert.equal(r.automatico, true);
  assert.deepEqual(r.palavras, []);
  assert.ok(r.nichos.length > 0);
});

const LISTA_DO_EDITOR = 'silas malafaia, pastor claudio duarte, cgadb, assembleia de deus, igreja mundial do poder de deus, igreja deus é amor, pastor hernandes dias lopes, teólogo, profecias, profeta, pastora, apostolo, apostola, rr soares, apostolo valdemiro santiago, bispo edir macedo, demonios, evangelicos, evangelicas, congresso evangelico, marcha para jesus, cantora gospel, cantor gospel, adoração';

test('24 palavras-chave viram 6 buscas no Google (OR) e no máximo 8 no YouTube', async () => {
  const r = await furos.buscarFuros({ userId: 1, nichos: ['auto'], palavras: LISTA_DO_EDITOR, limite: 25, completar: false });
  assert.equal(r.palavras.length, 24);
  assert.equal(chamadas.temas.length, 6);
  assert.equal(chamadas.temas[0].consultas[0], '"silas malafaia" OR "pastor claudio duarte" OR cgadb OR "assembleia de deus"');
  assert.ok(chamadas.consultasSociais.length <= 8);
  // Notícia do grupo fica com a palavra que ela cita.
  const malafaia = r.furos.find((f) => f.titulo === 'Silas Malafaia rebate críticas de deputado');
  assert.equal(malafaia.nicho, 'silas malafaia');
});

test('aceita até 30 palavras-chave', () => {
  const muitas = Array.from({ length: 40 }, (_, i) => `palavra${i}`).join(',');
  assert.equal(furos.palavrasValidas(muitas).length, 30);
});

test('rodízio do YouTube cobre todas as palavras ao longo do tempo', () => {
  const nichos = Array.from({ length: 20 }, (_, i) => ({ rotulo: `p${i}` }));
  const vistas = new Set();
  for (let bloco = 0; bloco < 3; bloco += 1) {
    furos.palavrasDaVezNoYoutube(nichos, bloco * 600_000).forEach((n) => vistas.add(n.rotulo));
  }
  assert.equal(vistas.size, 20);
});
