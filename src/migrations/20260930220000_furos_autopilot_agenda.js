/**
 * Piloto automático: agenda de funcionamento (sempre, todo dia das HH às HH
 * ou num período de datas), em JSON. Ver src/services/pilotoAgenda.js.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (await knex.schema.hasColumn('furos_autopilot', 'agenda')) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.text('agenda').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot', 'agenda'))) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.dropColumn('agenda');
  });
};
