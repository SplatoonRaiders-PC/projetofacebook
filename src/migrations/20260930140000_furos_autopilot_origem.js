/**
 * Fila do Furos do dia: marca de onde veio cada pauta.
 * - 'auto': escolhida pela IA na varredura do piloto automático;
 * - 'manual': marcada pelo editor no Furos do dia para gerar e publicar
 *   no intervalo escolhido, mesmo com o "Automatizar" desligado.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot_itens'))) return;
  if (await knex.schema.hasColumn('furos_autopilot_itens', 'origem')) return;
  await knex.schema.alterTable('furos_autopilot_itens', (table) => {
    table.string('origem', 10).notNullable().defaultTo('auto');
    table.index(['origem', 'status']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot_itens'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot_itens', 'origem'))) return;
  await knex.schema.alterTable('furos_autopilot_itens', (table) => {
    table.dropIndex(['origem', 'status']);
    table.dropColumn('origem');
  });
};
