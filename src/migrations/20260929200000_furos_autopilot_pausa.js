/**
 * Piloto automático do Furos: guarda desde quando está pausado, para o
 * painel mostrar "Pausado desde…" (a configuração e a fila continuam).
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (await knex.schema.hasColumn('furos_autopilot', 'pausado_at')) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.timestamp('pausado_at').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot', 'pausado_at'))) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.dropColumn('pausado_at');
  });
};
