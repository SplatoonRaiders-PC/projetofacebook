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
    return {
      totalAnalisado: 3,
      topicos: [
        { tema: 'Silas Malafaia', titulo: 'Silas Malafaia rebate críticas de deputado', link: 'https://ex.test/1', dataTimestamp: agora },
        { tema: 'Silas Malafaia', titulo: 'Malafaia faz culto em São Paulo', link: 'https://ex.test/2', dataTimestamp: agora },
        { tema: 'Silas Malafaia', titulo: 'Silas Malafaia anuncia evento com pastores', link: 'https://ex.test/3', dataTimestamp: agora },
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
    furos.palavrasValidas('Silas Malafaia, "Lagoinha"; malafaia, x, a1, b2, c3, d4'),
    ['Silas Malafaia', 'Lagoinha', 'malafaia', 'a1', 'b2']
  );
  assert.deepEqual(furos.palavrasValidas(['  André   Valadão ', 'André Valadão']), ['André Valadão']);
});

test('com Automático e palavra-chave, a busca fica só na palavra e exige todos os termos', async () => {
  const r = await furos.buscarFuros({ userId: 1, nichos: ['auto'], palavras: 'Silas Malafaia', limite: 10, completar: false });
  assert.deepEqual(r.palavras, ['Silas Malafaia']);
  assert.deepEqual(r.nichos, []);
  assert.equal(r.automatico, false);
  assert.deepEqual(chamadas.temas.map((t) => t.rotulo), ['Silas Malafaia']);
  assert.ok(chamadas.temas[0].consultas.includes('"Silas Malafaia"'));
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
  assert.deepEqual(chamadas.temas.map((t) => t.rotulo), ['Lagoinha', 'Pastores']);
  assert.deepEqual(chamadas.portaisNichos, ['pastores']);
});

test('sem nicho e sem palavra-chave continua usando o Automático', async () => {
  const r = await furos.buscarFuros({ userId: 1, nichos: [], palavras: '', limite: 5, completar: false });
  assert.equal(r.automatico, true);
  assert.deepEqual(r.palavras, []);
  assert.ok(r.nichos.length > 0);
});
