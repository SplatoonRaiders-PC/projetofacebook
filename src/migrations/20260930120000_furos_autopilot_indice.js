/**
 * Piloto automático do Furos: índice para o painel (/piloto-automatico) e
 * para o limite diário, que filtram por usuário + status + data.
 *
 * @param {import('knex').Knex} knex
 */
const NOME = 'furos_auto_itens_user_status_upd';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot_itens'))) return;
  const [linhas] = await knex.raw('SHOW INDEX FROM furos_autopilot_itens WHERE Key_name = ?', [NOME]);
  if (Array.isArray(linhas) && linhas.length) return;
  await knex.schema.alterTable('furos_autopilot_itens', (table) => {
    table.index(['user_id', 'status', 'updated_at'], NOME);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('furos_autopilot_itens'))) return;
  await knex.schema.alterTable('furos_autopilot_itens', (table) => {
    table.dropIndex(['user_id', 'status', 'updated_at'], NOME);
  });
};
