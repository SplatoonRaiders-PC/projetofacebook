const test = require('node:test');
const assert = require('node:assert/strict');

const { limparMarcacaoChatgpt, criarLimpadorDeStream } = require('../src/services/chatgptMarkup');
const { limparCorpoDoRascunho } = require('../src/services/materiaChatService');

const URL_VIDEO = 'https://www.youtube.com/watch?v=pmoYqytA_u0';
const LINK = `urlvídeo no YouTube${URL_VIDEO}`;

test('link do ChatGPT na Fonte vira só o endereço', () => {
  assert.equal(
    limparMarcacaoChatgpt(`**Fonte:** Gazeta do Povo — ${LINK}`),
    `**Fonte:** Gazeta do Povo — ${URL_VIDEO}`
  );
});

test('link do ChatGPT no corpo vira o texto do link', () => {
  assert.equal(limparMarcacaoChatgpt(`Veja o ${LINK} completo.`), 'Veja o vídeo no YouTube completo.');
});

test('remove citações e mantém o nome das entidades', () => {
  const texto = 'Segundo entity["people","Renan Ramalho","jornalista"], a pesquisa citeturn0search1 mostra empate.';
  assert.equal(limparMarcacaoChatgpt(texto), 'Segundo Renan Ramalho, a pesquisa  mostra empate.');
});

test('Fonte que já chegou colada é corrigida', () => {
  assert.equal(
    limparMarcacaoChatgpt(`**Fonte:** Gazeta do Povo — urlvídeo no YouTube${URL_VIDEO}`),
    `**Fonte:** Gazeta do Povo — ${URL_VIDEO}`
  );
});

test('streaming segura a marca aberta até ela fechar', () => {
  const limpador = criarLimpadorDeStream();
  const pedacos = ['Fonte: Gazeta — urlvíd', `eo no YouTube${URL_VIDEO}`, '\n\nFoto: Reprodução'];
  const saida = pedacos.map((pedaco) => limpador.empurrar(pedaco));
  assert.equal(saida[0], 'Fonte: Gazeta — ');
  assert.equal(saida[1], '');
  assert.equal(saida.join(''), `Fonte: Gazeta — ${URL_VIDEO}\n\nFoto: Reprodução`);
});

test('rascunho sai sem âncora, sem asteriscos e com a Fonte correta', () => {
  const corpo = [
    '**CENÁRIO ELEITORAL É ASSOCIADO A POSSÍVEL RECONFIGURAÇÃO DE FORÇAS EM BRASÍLIA**',
    '',
    'O avanço do senador nas pesquisas pode influenciar a dinâmica política envolvendo o Supremo Tribunal Federal (STF), segundo análise.',
    '',
    `**Fonte:** Gazeta do Povo — ${LINK}`,
    '',
    '**Foto:** Reprodução Internet',
    '',
    '#STF #JMNotícia',
    '',
    '**Siga o JM Notícia.**',
  ].join('\n');

  const limpo = limparCorpoDoRascunho(corpo);

  assert.ok(limpo.startsWith('O avanço do senador'));
  assert.ok(!limpo.includes('CENÁRIO ELEITORAL'));
  assert.ok(!limpo.includes('*'));
  assert.ok(limpo.includes(`Fonte: Gazeta do Povo — ${URL_VIDEO}`));
  assert.ok(limpo.includes('Foto: Reprodução Internet'));
  assert.ok(limpo.endsWith('Siga o JM Notícia.'));
});

test('âncora grudada no lead também sai', () => {
  const corpo = '**CENÁRIO ELEITORAL É ASSOCIADO A POSSÍVEL RECONFIGURAÇÃO** O avanço do senador nas pesquisas pode influenciar a dinâmica política envolvendo o Supremo.';
  assert.ok(limparCorpoDoRascunho(corpo).startsWith('O avanço do senador'));
});

test('lead normal não é confundido com âncora', () => {
  const corpo = 'O avanço do senador nas pesquisas pode influenciar a dinâmica política envolvendo o STF, segundo a análise publicada nesta semana.';
  assert.equal(limparCorpoDoRascunho(corpo), corpo);
});

const BLOCO_CLAUDE = [
  ':::writing{variant="document" id="31847" title="Osneia Farias publica registro com referência ao [[Brasil]] nas redes sociais"}',
  'Osneia Farias publica registro com referência ao [[Brasil]] nas redes sociais',
  '',
  'Osneia Farias publicou no Instagram um registro com referência ao Brasil.',
  '',
  'Siga o JM Notícia. :::',
].join('\n');

test('bloco :::writing do Claude web sai e o título volta a ser a 1ª linha', () => {
  const limpo = limparMarcacaoChatgpt(BLOCO_CLAUDE).trim();
  assert.equal(limpo.split('\n')[0], 'Osneia Farias publica registro com referência ao [[Brasil]] nas redes sociais');
  assert.ok(!limpo.includes(':::'));
  assert.ok(limpo.endsWith('Siga o JM Notícia.'));
});

test('texto comum com dois-pontos não é alterado pela limpeza do Claude', () => {
  const normal = 'Fonte: G1 — https://g1.globo.com/a\nHorário: 10:30';
  assert.equal(limparMarcacaoChatgpt(normal), normal);
});

test('streaming não mostra o bloco do Claude nem pela metade', () => {
  const limpador = criarLimpadorDeStream();
  const tela = [':::wri', 'ting{variant="document" id="1" title="T"}\nTítulo', '\n\nCorpo. ', ':::']
    .map((parte) => limpador.empurrar(parte))
    .join('');
  assert.ok(!tela.includes(':'));
  assert.ok(tela.startsWith('Título'));
});
