/**
 * Furos do dia: palavras-chave digitadas pelo editor, usadas também pelo
 * piloto automático em cada varredura (JSON com a lista).
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (await knex.schema.hasColumn('furos_autopilot', 'palavras')) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.text('palavras').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot', 'palavras'))) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.dropColumn('palavras');
  });
};
