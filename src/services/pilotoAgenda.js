/**
 * Agenda do piloto automático: em que horários ele trabalha sozinho, sem o
 * editor precisar ligar e desligar o "Automatizar".
 *
 * - sempre:  trabalha enquanto o Automatizar estiver ligado (como antes);
 * - diario:  todo dia (ou nos dias da semana marcados) das HH:MM às HH:MM.
 *            Fim menor que o início atravessa a meia-noite (22:00 → 06:00);
 * - periodo: de uma data/hora até outra (ex.: 01/10 06:00 → 01/10 23:00, ou
 *            hoje 07:00 → amanhã 23:00). Pode ter também um horário diário
 *            ("de 01/10 a 05/10, só das 07:00 às 23:00"). Ao terminar, o
 *            piloto se desliga sozinho.
 *
 * Horas valem no fuso do Brasil (APP_TIMEZONE, padrão America/Sao_Paulo),
 * qualquer que seja o relógio do servidor.
 */

const FUSO = process.env.APP_TIMEZONE || 'America/Sao_Paulo';
const MODOS = ['sempre', 'diario', 'periodo'];
const TODOS_OS_DIAS = [0, 1, 2, 3, 4, 5, 6];
const NOMES_DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

function erro(mensagem) {
  return Object.assign(new Error(mensagem), { status: 400 });
}

const formatador = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
});
const SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Data e hora "de parede" no fuso do Brasil. */
function partes(data) {
  const p = Object.fromEntries(formatador.formatToParts(data).map((x) => [x.type, x.value]));
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour) % 24,
    minuto: Number(p.minute),
    semana: SEMANA[p.weekday],
  };
}

/** O instante em que o relógio do Brasil marca essa data e hora. */
function instante(ano, mes, dia, minutosDoDia) {
  const chute = Date.UTC(ano, mes - 1, dia, 0, minutosDoDia);
  const p = partes(new Date(chute));
  const diferenca = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto) - chute;
  return new Date(chute - diferenca);
}

/** Dia do calendário deslocado em `n` dias (aritmética só de calendário). */
function somarDias({ ano, mes, dia }, n) {
  const d = new Date(Date.UTC(ano, mes - 1, dia + n));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(), semana: d.getUTCDay() };
}

function minutos(hhmm) {
  const m = HORA.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function horaTexto(data) {
  const p = partes(data);
  return `${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`;
}

function dataHoraTexto(data, agora = new Date()) {
  const p = partes(data);
  const hoje = partes(agora);
  const amanha = somarDias(hoje, 1);
  const mesmoDia = (a, b) => a.ano === b.ano && a.mes === b.mes && a.dia === b.dia;
  const dia = mesmoDia(p, hoje)
    ? 'hoje'
    : mesmoDia(p, amanha)
      ? 'amanhã'
      : `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}`;
  return `${dia} às ${horaTexto(data)}`;
}

function dataValida(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Valida o que vem do formulário. Lança erro 400 com mensagem para o editor. */
function normalizarAgenda(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const modo = MODOS.includes(e.modo) ? e.modo : 'sempre';
  if (modo === 'sempre') return { modo };

  const temHorario = modo === 'diario' || Boolean(e.horario_inicio || e.horario_fim);
  let horario = null;
  if (temHorario) {
    const inicio = minutos(e.horario_inicio);
    const fim = minutos(e.horario_fim);
    if (inicio == null || fim == null) throw erro('Informe o horário de início e de fim (HH:MM).');
    if (inicio === fim) throw erro('O horário de início e de fim não podem ser iguais.');
    horario = { horario_inicio: e.horario_inicio, horario_fim: e.horario_fim };
  }

  if (modo === 'diario') {
    const dias = [...new Set((Array.isArray(e.dias) ? e.dias : TODOS_OS_DIAS).map(Number))]
      .filter((d) => TODOS_OS_DIAS.includes(d))
      .sort();
    if (!dias.length) throw erro('Marque pelo menos um dia da semana.');
    return { modo, ...horario, dias };
  }

  const inicio = dataValida(e.inicio_at);
  const fim = dataValida(e.fim_at);
  if (!inicio || !fim) throw erro('Informe a data e hora de início e de fim do período.');
  if (fim <= inicio) throw erro('O fim do período precisa ser depois do início.');
  if (fim.getTime() - inicio.getTime() > 366 * 86_400_000) throw erro('O período pode ter no máximo 1 ano.');
  return { modo, inicio_at: inicio.toISOString(), fim_at: fim.toISOString(), ...(horario || {}) };
}

function lerAgenda(valor) {
  if (!valor) return { modo: 'sempre' };
  try {
    const agenda = typeof valor === 'string' ? JSON.parse(valor) : valor;
    return MODOS.includes(agenda?.modo) ? agenda : { modo: 'sempre' };
  } catch {
    return { modo: 'sempre' };
  }
}

/**
 * Janela diária em `agora`: { dentro, fim } — `fim` é quando a janela atual
 * fecha. Janela que atravessa a meia-noite pertence ao dia em que começou.
 */
function janelaDiaria(agenda, agora) {
  const ini = minutos(agenda.horario_inicio);
  const fim = minutos(agenda.horario_fim);
  const dias = Array.isArray(agenda.dias) && agenda.dias.length ? agenda.dias : TODOS_OS_DIAS;
  const hoje = partes(agora);
  const agoraMin = hoje.hora * 60 + hoje.minuto;
  if (ini < fim) {
    const dentro = dias.includes(hoje.semana) && agoraMin >= ini && agoraMin < fim;
    return { dentro, fim: dentro ? instante(hoje.ano, hoje.mes, hoje.dia, fim) : null };
  }
  if (agoraMin >= ini) {
    const dentro = dias.includes(hoje.semana);
    const amanha = somarDias(hoje, 1);
    return { dentro, fim: dentro ? instante(amanha.ano, amanha.mes, amanha.dia, fim) : null };
  }
  if (agoraMin < fim) {
    const ontem = somarDias(hoje, -1);
    const dentro = dias.includes(ontem.semana);
    return { dentro, fim: dentro ? instante(hoje.ano, hoje.mes, hoje.dia, fim) : null };
  }
  return { dentro: false, fim: null };
}

/** Próximo início da janela diária depois de `apos`. */
function proximoInicioDiario(agenda, apos) {
  const ini = minutos(agenda.horario_inicio);
  const dias = Array.isArray(agenda.dias) && agenda.dias.length ? agenda.dias : TODOS_OS_DIAS;
  const base = partes(apos);
  for (let n = 0; n <= 8; n += 1) {
    const dia = somarDias(base, n);
    if (!dias.includes(dia.semana)) continue;
    const quando = instante(dia.ano, dia.mes, dia.dia, ini);
    if (quando > apos) return quando;
  }
  return null;
}

/** Texto curto da regra, para o painel. */
function descrever(agenda) {
  if (agenda.modo === 'diario') {
    const dias = agenda.dias?.length && agenda.dias.length < 7
      ? agenda.dias.map((d) => NOMES_DIAS[d]).join(', ')
      : 'todo dia';
    return `${dias}, das ${agenda.horario_inicio} às ${agenda.horario_fim}`;
  }
  if (agenda.modo === 'periodo') {
    const fmt = (iso) => {
      const p = partes(new Date(iso));
      return `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')} ${horaTexto(new Date(iso))}`;
    };
    const horas = agenda.horario_inicio ? `, só das ${agenda.horario_inicio} às ${agenda.horario_fim}` : '';
    return `de ${fmt(agenda.inicio_at)} até ${fmt(agenda.fim_at)}${horas}`;
  }
  return 'sempre que o Automatizar estiver ligado';
}

/**
 * Situação da agenda agora:
 * - dentro: pode trabalhar;
 * - fim: quando a janela atual fecha (o piloto não agenda depois disso);
 * - proximoInicio: quando volta a trabalhar (fora do horário);
 * - encerrada: período que já terminou (o piloto se desliga).
 */
function situacao(valor, agora = new Date()) {
  const agenda = lerAgenda(valor);
  const base = { modo: agenda.modo, regra: descrever(agenda), dentro: true, fim: null, proximoInicio: null, encerrada: false };
  if (agenda.modo === 'sempre') return base;

  if (agenda.modo === 'diario') {
    const janela = janelaDiaria(agenda, agora);
    return janela.dentro
      ? { ...base, fim: janela.fim }
      : { ...base, dentro: false, proximoInicio: proximoInicioDiario(agenda, agora) };
  }

  const inicio = new Date(agenda.inicio_at);
  const fim = new Date(agenda.fim_at);
  if (agora >= fim) return { ...base, dentro: false, encerrada: true };
  const comHorario = Boolean(agenda.horario_inicio);
  if (agora >= inicio) {
    if (!comHorario) return { ...base, fim };
    const janela = janelaDiaria(agenda, agora);
    if (janela.dentro) return { ...base, fim: janela.fim < fim ? janela.fim : fim };
  }
  // Fora: o próximo início é o começo do período ou da próxima janela diária.
  let proximo = agora < inicio ? inicio : null;
  if (comHorario) {
    const referencia = agora < inicio ? inicio : agora;
    proximo = janelaDiaria(agenda, referencia).dentro && agora < inicio
      ? inicio
      : proximoInicioDiario(agenda, referencia);
  }
  // Nenhuma janela cabe antes do fim do período: não há mais o que fazer.
  if (!proximo || proximo >= fim) return { ...base, dentro: false, encerrada: true };
  return { ...base, dentro: false, proximoInicio: proximo };
}

/** Frase para o editor: "trabalhando até 23:00", "começa amanhã às 07:00"… */
function frase(sit, agora = new Date()) {
  if (sit.modo === 'sempre') return '';
  if (sit.encerrada) return 'período da agenda terminou';
  if (sit.dentro) return sit.fim ? `no horário até ${dataHoraTexto(sit.fim, agora)}` : 'no horário';
  return sit.proximoInicio ? `fora do horário · começa ${dataHoraTexto(sit.proximoInicio, agora)}` : 'fora do horário';
}

module.exports = { FUSO, MODOS, normalizarAgenda, lerAgenda, situacao, frase, descrever, partes, instante };
