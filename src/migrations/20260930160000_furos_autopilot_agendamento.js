/**
 * Fila do Furos do dia: a matéria pronta é AGENDADA no agendador do sistema
 * (aparece como "Agendado" em Matérias salvas) e publicada por ele. Aqui fica
 * o horário marcado de cada item.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot_itens'))) return;
  if (await knex.schema.hasColumn('furos_autopilot_itens', 'agendado_para')) return;
  await knex.schema.alterTable('furos_autopilot_itens', (table) => {
    table.timestamp('agendado_para').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot_itens'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot_itens', 'agendado_para'))) return;
  await knex.schema.alterTable('furos_autopilot_itens', (table) => {
    table.dropColumn('agendado_para');
  });
};
