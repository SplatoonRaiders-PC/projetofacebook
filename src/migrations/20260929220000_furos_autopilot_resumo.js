/**
 * Piloto automático do Furos: resumo da última varredura ("3 pautas novas,
 * 2 aprovadas pela IA…"), para o painel mostrar por que a fila está vazia.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (await knex.schema.hasColumn('furos_autopilot', 'ultimo_scan_resumo')) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.string('ultimo_scan_resumo', 500).nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot', 'ultimo_scan_resumo'))) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.dropColumn('ultimo_scan_resumo');
  });
};
