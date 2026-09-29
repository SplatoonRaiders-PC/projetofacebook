/**
 * Piloto automático do Furos do dia: a cada poucos minutos procura pautas
 * novas, a IA escolhe as melhores, escreve, gera a imagem com IA e publica
 * na página no intervalo escolhido pelo editor.
 *
 * - furos_autopilot: uma configuração por usuário (liga/desliga, nichos,
 *   fontes, intervalo, página…);
 * - furos_autopilot_itens: cada pauta avaliada e o caminho dela até publicar.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot'))) {
    await knex.schema.createTable('furos_autopilot', (table) => {
      table.increments('id').primary();
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .unique()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      table.boolean('ativo').notNullable().defaultTo(false).index();
      table.text('nichos').nullable();
      table.text('canais').nullable();
      table.integer('horas').unsigned().notNullable().defaultTo(24);
      table.integer('intervalo_minutos').unsigned().notNullable().defaultTo(10);
      table.integer('limite_dia').unsigned().notNullable().defaultTo(40);
      table
        .integer('facebook_page_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('facebook_pages')
        .onDelete('SET NULL');
      table.string('modelo', 120).nullable();
      table.boolean('foto_original_se_falhar').notNullable().defaultTo(true);
      table.timestamp('ultimo_scan_at').nullable();
      table.timestamp('proxima_postagem_at').nullable();
      table.string('ultimo_erro', 500).nullable();
      table.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('furos_autopilot_itens'))) {
    await knex.schema.createTable('furos_autopilot_itens', (table) => {
      table.increments('id').primary();
      table
        .integer('user_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      // Link normalizado (hash) para nunca avaliar a mesma pauta duas vezes.
      table.string('chave', 64).notNullable();
      table.string('canal', 16).notNullable();
      table.string('titulo', 500).nullable();
      table.string('url', 1000).notNullable();
      table.text('pauta').nullable();
      table.integer('score').unsigned().notNullable().defaultTo(0);
      table.integer('nota_ia').unsigned().nullable();
      table.string('motivo', 255).nullable();
      // na_fila | escrevendo | aguardando_imagem | gerando_imagem | pronta |
      // publicando | publicada | descartada | erro
      table.string('status', 24).notNullable().defaultTo('na_fila');
      table
        .integer('matter_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('ai_matters')
        .onDelete('SET NULL');
      table.integer('tentativas').unsigned().notNullable().defaultTo(0);
      table.boolean('imagem_ia').notNullable().defaultTo(false);
      table.string('erro', 500).nullable();
      table.timestamp('publicado_at').nullable();
      table.timestamps(true, true);

      table.unique(['user_id', 'chave']);
      table.index(['user_id', 'status']);
      table.index(['status', 'created_at']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('furos_autopilot_itens');
  await knex.schema.dropTableIfExists('furos_autopilot');
};
