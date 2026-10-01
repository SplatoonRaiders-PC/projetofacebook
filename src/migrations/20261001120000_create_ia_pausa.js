/**
 * Botão "Parar IA" da página /claude: pausa geral (todos os modelos) e pausa
 * por modelo. Enquanto pausado, quem pedir a IA recebe a mensagem de créditos.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ia_pausa'))) {
    await knex.schema.createTable('ia_pausa', (table) => {
      table.increments('id').primary();
      table.boolean('pausado_geral').notNullable().defaultTo(false);
      // Modelos pausados, em JSON (ex.: ["claude-sonnet-5","gpt-5.6"]).
      table.text('modelos_pausados').nullable();
      table.integer('atualizado_por').unsigned().nullable();
      table.timestamps(true, true);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ia_pausa');
};
