const test = require('node:test');
const assert = require('node:assert/strict');

const { lerRss, lerWordPress } = require('../src/services/portaisNichoService');
const { mesclarPortais, NICHOS } = require('../src/services/furosService');

const PORTAL = { nome: 'Portal Teste' };
const AGORA = Date.parse('2026-09-30T12:00:00Z');

test('lê título, link, data e foto do feed RSS e tira o rodapé do resumo', () => {
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[Pastor anuncia campanha &amp; culto especial]]></title>
      <link>https://portal.exemplo/pastor-campanha</link>
      <pubDate>Tue, 30 Sep 2026 10:00:00 +0000</pubDate>
      <description><![CDATA[<p>Resumo curto da notícia.</p> Leia a matéria completa em Portalteste]]></description>
      <media:content url="https://portal.exemplo/foto.jpg" medium="image" />
    </item>
  </channel></rss>`;
  const [item] = lerRss(xml, PORTAL);
  assert.equal(item.titulo, 'Pastor anuncia campanha & culto especial');
  assert.equal(item.link, 'https://portal.exemplo/pastor-campanha');
  assert.equal(item.imagem, 'https://portal.exemplo/foto.jpg');
  assert.equal(item.resumo, 'Resumo curto da notícia.');
  assert.equal(item.dataTimestamp, Date.parse('2026-09-30T10:00:00Z'));
  assert.equal(item.veiculo, 'Portal Teste');
});

test('lê posts da API do WordPress com a foto destacada', () => {
  const [item] = lerWordPress([{
    title: { rendered: 'Cantor lan&#231;a &#8220;single&#8221;' },
    link: 'https://portal.exemplo/cantor',
    date_gmt: '2026-09-30T09:00:00',
    excerpt: { rendered: '<p>Resumo.</p>' },
    jetpack_featured_media_url: 'https://portal.exemplo/capa.jpg',
  }], PORTAL);
  assert.equal(item.titulo, 'Cantor lança “single”');
  assert.equal(item.imagem, 'https://portal.exemplo/capa.jpg');
  assert.equal(item.dataTimestamp, Date.parse('2026-09-30T09:00:00Z'));
});

function doPortal(extra) {
  return {
    link: 'https://portal.exemplo/materia',
    veiculo: 'Guiame',
    resumo: '',
    imagem: 'https://portal.exemplo/foto.jpg',
    dataTimestamp: AGORA - 3_600_000,
    portalNichos: ['igreja', 'pastores', 'gospel'],
    especializado: true,
    ...extra,
  };
}

const nichos = (...ids) => NICHOS.filter((n) => ids.includes(n.id));

test('mesma notícia do Google e do portal vira uma pauta com link direto e foto do portal', () => {
  const doGoogle = [{
    canal: 'noticias',
    noNicho: true,
    titulo: 'Conselho de pastores divulga nota sobre eleição presidencial',
    url: 'https://news.google.com/rss/articles/abc',
    veiculo: 'Jornal X',
    veiculos: [],
    imagem: null,
    nicho: 'Pastores',
    score: 30,
    motivos: ['Em alta no Google'],
  }];
  const [pauta] = mesclarPortais(
    doGoogle,
    [doPortal({ titulo: 'Conselho de pastores divulga nota sobre a eleição presidencial' })],
    nichos('pastores'),
    AGORA
  );
  assert.equal(pauta.url, 'https://portal.exemplo/materia');
  assert.equal(pauta.veiculo, 'Guiame');
  assert.equal(pauta.imagem, 'https://portal.exemplo/foto.jpg');
  assert.ok(pauta.score > 30);
  assert.ok(pauta.motivos.includes('Em alta no Google'), 'sinal do Google não pode sumir');
  assert.ok(pauta.motivos.includes('2 veículos'));
});

test('portal geral só entra quando o nicho está no título', () => {
  const geral = { portalNichos: ['politica'], especializado: false, veiculo: 'CNN Brasil' };
  const pautas = mesclarPortais([], [
    doPortal({ ...geral, titulo: 'Clube de futebol processa ex-presidente', resumo: 'O caso envolve deputado estadual.' }),
    doPortal({ ...geral, titulo: 'Senado aprova projeto do governo', link: 'https://portal.exemplo/senado' }),
  ], nichos('politica'), AGORA);
  assert.deepEqual(pautas.map((p) => p.titulo), ['Senado aprova projeto do governo']);
});

test('notícia de portal gospel sem palavra-chave não cai em Música gospel', () => {
  const [pauta] = mesclarPortais([], [
    doPortal({ titulo: 'Ministra critica declaração sobre mulheres' }),
  ], nichos('igreja', 'gospel'), AGORA);
  assert.equal(pauta.nicho, 'Igreja');
});
