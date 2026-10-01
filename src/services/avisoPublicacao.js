const db = require('../config/db');

/**
 * Aviso no celular (app ntfy) para TODA matéria que muda para publicada — a
 * mesma lista de /minhas-materias?status=publicado — e para a que falha ao
 * publicar. Vale para publicação manual, agendada, do piloto automático,
 * da Biblioteca…: o gancho fica em AiMatters.update.
 *
 * O tópico e as opções ficam na configuração do piloto (furos_autopilot,
 * colunas ntfy_*), editadas em /piloto-automatico.
 */

async function configDoUsuario(userId) {
  try {
    return await db('furos_autopilot')
      .where({ user_id: userId })
      .first('ntfy_topico', 'ntfy_servidor', 'ntfy_token', 'ntfy_publicada', 'ntfy_falha');
  } catch {
    return null; // tabela/colunas ainda não migradas
  }
}

const ligado = (valor) => valor !== false && valor !== 0 && valor !== '0';

function tituloLimpo(texto) {
  return String(texto || '')
    .replace(/\[\[|\]\]|\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

async function enviar(matterId, status, { ntfy = require('./ntfyService') } = {}) {
  const AiMatters = require('../models/AiMatters');
  const matter = await AiMatters.findById(matterId);
  if (!matter) return false;
  const cfg = await configDoUsuario(matter.user_id);
  if (!cfg?.ntfy_topico) return false;
  const publicada = status === 'publicado';
  if (!ligado(publicada ? cfg.ntfy_publicada : cfg.ntfy_falha)) return false;

  const [pagina, publicacao] = await Promise.all([
    matter.facebook_page_id
      ? db('facebook_pages').where({ id: matter.facebook_page_id }).first('page_name').catch(() => null)
      : null,
    matter.publication_id
      ? db('publications').where({ id: matter.publication_id }).first('fb_post_url').catch(() => null)
      : null,
  ]);
  const base = String(require('../config/env').appPublicUrl || '').replace(/\/$/, '');
  const linkDoSite = base ? `${base}/materias-ia/${matter.id}` : null;
  const titulo = tituloLimpo(matter.titulo) || 'Matéria sem título';
  const nomePagina = pagina?.page_name ? ` · ${pagina.page_name}` : '';

  await ntfy.enviar({
    servidor: cfg.ntfy_servidor,
    topico: cfg.ntfy_topico,
    token: cfg.ntfy_token,
    titulo: `${publicada ? 'Publicada' : 'Não publicada'}${nomePagina}`,
    mensagem: publicada
      ? titulo
      : `${titulo}\n\nMotivo: ${String(matter.error_message || 'falha ao publicar.').slice(0, 500)}`,
    tags: publicada ? ['white_check_mark'] : ['x'],
    prioridade: publicada ? 3 : 4,
    // Publicada: abre o post no Facebook; senão, a matéria no site.
    clique: (publicada && publicacao?.fb_post_url) || linkDoSite,
  });
  return true;
}

/** Não segura quem publicou: o aviso sai em segundo plano e falha em silêncio. */
function avisar(matterId, status) {
  setImmediate(() => {
    enviar(matterId, status).catch((err) => console.warn(`[aviso-publicacao] matéria ${matterId}:`, err.message));
  });
}

module.exports = { avisar, enviar };
