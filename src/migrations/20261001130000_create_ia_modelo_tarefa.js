/**
 * Modelo fixo por tarefa, escolhido pelo administrador em /claude:
 *   piloto  — matérias escritas pelo piloto automático;
 *   titulos — sugerir e reescrever títulos.
 * Sem linha (ou modelo vazio) = comportamento de antes.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ia_modelo_tarefa')) return;
  await knex.schema.createTable('ia_modelo_tarefa', (table) => {
    table.increments('id').primary();
    table.string('tarefa', 32).notNullable().unique();
    table.string('modelo', 120).nullable();
    table.integer('atualizado_por').unsigned().nullable();
    table.timestamps(true, true);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ia_modelo_tarefa');
};
