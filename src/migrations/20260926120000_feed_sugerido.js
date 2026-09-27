/**
 * Feed sugerido: coleta os Reels/Shorts/vídeos que Instagram, YouTube e
 * Facebook sugerem para a conta dos cookies e transforma cada um em matéria.
 *
 * - app_settings: configurações globais (o admin liga/desliga cada rede).
 * - feed_sugerido_jobs: cada execução pedida em /materia-manual.
 * - feed_sugerido_itens: cada vídeo coletado (evita repetir o mesmo vídeo).
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) {
    await knex.schema.createTable('app_settings', (table) => {
      table.increments('id').primary();
      table.string('chave', 80).notNullable().unique();
      table.text('valor').nullable();
      table.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('feed_sugerido_jobs'))) {
    await knex.schema.createTable('feed_sugerido_jobs', (table) => {
      table.increments('id').primary();
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      table
        .integer('facebook_page_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('facebook_pages')
        .onDelete('SET NULL');
      table.string('plataformas', 64).notNullable();
      table.integer('quantidade').unsigned().notNullable().defaultTo(10);
      table.text('opcoes').nullable();
      // na_fila | coletando | processando | concluido | erro | cancelado
      table.string('status', 20).notNullable().defaultTo('na_fila');
      table.integer('total').unsigned().notNullable().defaultTo(0);
      table.integer('concluidos').unsigned().notNullable().defaultTo(0);
      table.integer('falhas').unsigned().notNullable().defaultTo(0);
      table.string('mensagem', 500).nullable();
      table.text('coleta').nullable();
      table.timestamp('started_at').nullable();
      table.timestamp('finished_at').nullable();
      table.timestamps(true, true);

      table.index(['user_id', 'created_at']);
      table.index(['status']);
    });
  }

  if (!(await knex.schema.hasTable('feed_sugerido_itens'))) {
    await knex.schema.createTable('feed_sugerido_itens', (table) => {
      table.increments('id').primary();
      table
        .integer('job_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('feed_sugerido_jobs')
        .onDelete('CASCADE');
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      table.string('plataforma', 16).notNullable();
      table.string('external_id', 64).notNullable();
      table.string('url', 1000).notNullable();
      table.string('titulo', 500).nullable();
      table.string('autor', 160).nullable();
      table.text('thumbnail').nullable();
      // pendente | lendo | transcrevendo | escrevendo | pronto | ignorado | erro
      table.string('status', 20).notNullable().defaultTo('pendente');
      table.string('etapa', 255).nullable();
      table
        .integer('matter_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ai_matters')
        .onDelete('SET NULL');
      table.string('erro', 500).nullable();
      table.timestamps(true, true);

      table.index(['job_id']);
      table.index(['user_id', 'plataforma', 'external_id']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('feed_sugerido_itens');
  await knex.schema.dropTableIfExists('feed_sugerido_jobs');
  await knex.schema.dropTableIfExists('app_settings');
};
