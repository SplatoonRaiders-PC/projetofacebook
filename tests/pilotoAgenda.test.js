const test = require('node:test');
const assert = require('node:assert/strict');

const agenda = require('../src/services/pilotoAgenda');

// Horário de Brasília (UTC-3): 2026-10-01 10:00 BRT = 13:00Z. 01/10/2026 é quinta (4).
const brt = (iso) => new Date(`${iso}-03:00`);

test('sempre: trabalha o tempo todo', () => {
  const s = agenda.situacao(null, brt('2026-10-01T03:00:00'));
  assert.equal(s.dentro, true);
  assert.equal(s.fim, null);
});

test('diário 07:00–23:00: dentro, fora e próximo início', () => {
  const regra = agenda.normalizarAgenda({ modo: 'diario', horario_inicio: '07:00', horario_fim: '23:00' });
  const dentro = agenda.situacao(regra, brt('2026-10-01T10:00:00'));
  assert.equal(dentro.dentro, true);
  assert.equal(dentro.fim.toISOString(), brt('2026-10-01T23:00:00').toISOString());

  const madrugada = agenda.situacao(regra, brt('2026-10-01T05:30:00'));
  assert.equal(madrugada.dentro, false);
  assert.equal(madrugada.proximoInicio.toISOString(), brt('2026-10-01T07:00:00').toISOString());

  const noite = agenda.situacao(regra, brt('2026-10-01T23:30:00'));
  assert.equal(noite.dentro, false);
  assert.equal(noite.proximoInicio.toISOString(), brt('2026-10-02T07:00:00').toISOString());
  assert.match(agenda.frase(noite, brt('2026-10-01T23:30:00')), /começa amanhã às 07:00/);
});

test('diário que atravessa a meia-noite (22:00 → 06:00)', () => {
  const regra = agenda.normalizarAgenda({ modo: 'diario', horario_inicio: '22:00', horario_fim: '06:00' });
  const tarde = agenda.situacao(regra, brt('2026-10-01T23:00:00'));
  assert.equal(tarde.dentro, true);
  assert.equal(tarde.fim.toISOString(), brt('2026-10-02T06:00:00').toISOString());
  const cedo = agenda.situacao(regra, brt('2026-10-02T05:00:00'));
  assert.equal(cedo.dentro, true);
  assert.equal(agenda.situacao(regra, brt('2026-10-02T12:00:00')).dentro, false);
});

test('diário só em alguns dias da semana', () => {
  // seg a sex; 03/10/2026 é sábado.
  const regra = agenda.normalizarAgenda({ modo: 'diario', horario_inicio: '08:00', horario_fim: '18:00', dias: [1, 2, 3, 4, 5] });
  assert.equal(agenda.situacao(regra, brt('2026-10-02T09:00:00')).dentro, true);
  const sabado = agenda.situacao(regra, brt('2026-10-03T09:00:00'));
  assert.equal(sabado.dentro, false);
  assert.equal(sabado.proximoInicio.toISOString(), brt('2026-10-05T08:00:00').toISOString());
  assert.match(sabado.regra, /seg, ter, qua, qui, sex/);
});

test('período num dia (01/10 06:00 → 23:00) e encerramento', () => {
  const regra = agenda.normalizarAgenda({
    modo: 'periodo',
    inicio_at: brt('2026-10-01T06:00:00').toISOString(),
    fim_at: brt('2026-10-01T23:00:00').toISOString(),
  });
  const antes = agenda.situacao(regra, brt('2026-09-30T20:00:00'));
  assert.equal(antes.dentro, false);
  assert.equal(antes.proximoInicio.toISOString(), brt('2026-10-01T06:00:00').toISOString());
  const durante = agenda.situacao(regra, brt('2026-10-01T12:00:00'));
  assert.equal(durante.dentro, true);
  assert.equal(durante.fim.toISOString(), brt('2026-10-01T23:00:00').toISOString());
  const depois = agenda.situacao(regra, brt('2026-10-01T23:00:00'));
  assert.equal(depois.dentro, false);
  assert.equal(depois.encerrada, true);
});

test('período de vários dias só das 07:00 às 23:00', () => {
  const regra = agenda.normalizarAgenda({
    modo: 'periodo',
    inicio_at: brt('2026-10-01T00:00:00').toISOString(),
    fim_at: brt('2026-10-05T23:59:00').toISOString(),
    horario_inicio: '07:00',
    horario_fim: '23:00',
  });
  const noite = agenda.situacao(regra, brt('2026-10-02T02:00:00'));
  assert.equal(noite.dentro, false);
  assert.equal(noite.proximoInicio.toISOString(), brt('2026-10-02T07:00:00').toISOString());
  const dia = agenda.situacao(regra, brt('2026-10-03T08:00:00'));
  assert.equal(dia.dentro, true);
  assert.equal(dia.fim.toISOString(), brt('2026-10-03T23:00:00').toISOString());
  // Último dia, depois das 23h: não há mais janela antes do fim.
  assert.equal(agenda.situacao(regra, brt('2026-10-05T23:30:00')).encerrada, true);
});

test('validação com mensagens claras', () => {
  assert.throws(() => agenda.normalizarAgenda({ modo: 'diario', horario_inicio: '7h', horario_fim: '23:00' }), /HH:MM/);
  assert.throws(() => agenda.normalizarAgenda({ modo: 'diario', horario_inicio: '07:00', horario_fim: '07:00' }), /iguais/);
  assert.throws(() => agenda.normalizarAgenda({ modo: 'diario', horario_inicio: '07:00', horario_fim: '23:00', dias: [] }), /dia da semana/);
  assert.throws(() => agenda.normalizarAgenda({ modo: 'periodo', inicio_at: '2026-10-02T10:00', fim_at: '2026-10-01T10:00' }), /depois do início/);
  assert.deepEqual(agenda.normalizarAgenda({ modo: 'xyz' }), { modo: 'sempre' });
});
