const test = require('node:test');
const assert = require('node:assert/strict');

const { pontuarBomba, listarNichos } = require('../src/services/furosService');

const AGORA = Date.parse('2026-09-29T15:00:00Z');

test('notícia coberta por vários veículos, recente e com denúncia fica no topo', () => {
  const bomba = pontuarBomba({
    titulo: 'PF prende pastor investigado por desvio de dízimos',
    resumo: 'Operação cumpriu mandados em três estados.',
    contagemFontes: 6,
    sinalGoogleNews: true,
    dataTimestamp: AGORA - 2 * 3_600_000,
  }, AGORA);
  const morna = pontuarBomba({
    titulo: 'Igreja realiza encontro de casais no fim de semana',
    contagemFontes: 1,
    dataTimestamp: AGORA - 20 * 3_600_000,
  }, AGORA);

  assert.ok(bomba.score >= 55, `esperava bombástica, veio ${bomba.score}`);
  assert.ok(morna.score < 30, `esperava morna, veio ${morna.score}`);
  assert.ok(bomba.motivos.includes('6 veículos'));
  assert.ok(bomba.motivos.includes('Denúncia'));
});

test('palavra-gatilho só conta como palavra inteira', () => {
  // "prefeitura" contém "pf" e "desprezo" contém "preso": não podem pontuar.
  const { motivos } = pontuarBomba({ titulo: 'Prefeitura anuncia obra e rebate desprezo', contagemFontes: 1 }, AGORA);
  assert.ok(!motivos.includes('Justiça'));
});

test('nota fica entre 0 e 100 mesmo com todos os sinais', () => {
  const { score } = pontuarBomba({
    titulo: 'Urgente: escândalo, preso, morte, polêmica e reviravolta exclusiva, briga',
    contagemFontes: 20,
    sinalGoogleNews: true,
    sinalRedes: true,
    dataTimestamp: AGORA,
  }, AGORA);
  assert.equal(score, 100);
});

test('lista de nichos inclui política, igreja e pastores', () => {
  const ids = listarNichos().map((n) => n.id);
  for (const id of ['politica', 'igreja', 'pastores']) assert.ok(ids.includes(id));
});
