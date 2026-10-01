/**
 * Piloto automático: aviso no app ntfy quando uma matéria é publicada ou não
 * é publicada (erro na escrita, na imagem ou no envio).
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (await knex.schema.hasColumn('furos_autopilot', 'ntfy_topico')) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.string('ntfy_topico', 64).nullable();
    table.string('ntfy_servidor', 255).nullable();
    table.string('ntfy_token', 255).nullable();
    table.boolean('ntfy_publicada').notNullable().defaultTo(true);
    table.boolean('ntfy_falha').notNullable().defaultTo(true);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) return;
  if (!(await knex.schema.hasColumn('furos_autopilot', 'ntfy_topico'))) return;
  await knex.schema.alterTable('furos_autopilot', (table) => {
    table.dropColumn('ntfy_topico');
    table.dropColumn('ntfy_servidor');
    table.dropColumn('ntfy_token');
    table.dropColumn('ntfy_publicada');
    table.dropColumn('ntfy_falha');
  });
};
