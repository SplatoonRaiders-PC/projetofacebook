/* Feed sugerido — Reels/Shorts/vídeos que as redes sugerem viram matérias. */
(function () {
  const painel = document.getElementById('feed-sugerido');
  if (!painel) return;

  const $ = (id) => document.getElementById(id);
  const backdrop = $('feed-sugerido-backdrop');
  const form = $('feed-sugerido-form');
  const redesEl = $('feed-sugerido-redes');
  const linksEl = $('feed-sugerido-links');
  const qtdEl = $('feed-sugerido-qtd');
  const paginaEl = $('feed-sugerido-pagina');
  const temaEl = $('feed-sugerido-tema');
  const tomEl = $('feed-sugerido-tom');
  const webEl = $('feed-sugerido-web');
  const resumoEl = $('feed-sugerido-resumo');
  const erroEl = $('feed-sugerido-erro');
  const iniciarBtn = $('feed-sugerido-iniciar');
  const jobEl = $('feed-sugerido-job');
  const histEl = $('feed-sugerido-historico');

  const ATIVOS = ['na_fila', 'coletando', 'processando'];
  const STATUS_JOB = {
    na_fila: 'Na fila',
    coletando: 'Abrindo as sugestões…',
    processando: 'Criando matérias…',
    concluido: 'Concluído',
    erro: 'Não concluído',
    cancelado: 'Cancelado',
  };
  const STATUS_ITEM = {
    pendente: ['Aguardando', 'is-andamento'],
    lendo: ['Lendo post', 'is-andamento'],
    transcrevendo: ['Ouvindo áudio', 'is-andamento'],
    escrevendo: ['Escrevendo', 'is-andamento'],
    pronto: ['Matéria pronta', 'is-pronto'],
    ignorado: ['Pulado', 'is-ignorado'],
    erro: ['Falhou', 'is-erro'],
  };
  const EXEMPLO_LINK = {
    instagram: 'https://www.instagram.com/reels/…',
    youtube: 'https://www.youtube.com/shorts/…',
    facebook: 'https://www.facebook.com/reel/…',
  };

  let config = null;
  let jobAtual = null;
  let timer = null;
  let paginasCarregadas = false;

  function esc(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(url, opcoes = {}) {
    const res = await fetch(url, {
      ...opcoes,
      headers: { Accept: 'application/json', ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha na comunicação com o servidor.');
    return data;
  }

  function redesDisponiveis() {
    return (config?.plataformas || []).filter((p) => p.habilitada);
  }

  function redesMarcadas() {
    return [...redesEl.querySelectorAll('input[name="feed-rede"]:checked')].map((el) => el.value);
  }

  function atualizarResumo() {
    const marcadas = redesMarcadas();
    const qtd = Math.max(1, Number(qtdEl.value) || 1);
    resumoEl.textContent = marcadas.length
      ? `Até ${qtd * marcadas.length} matéria(s): ${qtd} de cada rede marcada. Vídeos que já viraram matéria são pulados.`
      : 'Marque pelo menos uma rede.';
    // Um campo de link por rede marcada (ponto de partida opcional).
    const atuais = {};
    linksEl.querySelectorAll('input[data-rede]').forEach((el) => { atuais[el.dataset.rede] = el.value; });
    linksEl.innerHTML = marcadas
      .map((rede) => {
        const nome = (config.plataformas.find((p) => p.id === rede) || {}).nome || rede;
        return `<label><span>Link para começar no ${esc(nome)} <small>(opcional — as sugestões a partir deste vídeo)</small></span>
          <input type="url" data-rede="${esc(rede)}" maxlength="1000" placeholder="${esc(EXEMPLO_LINK[rede] || 'https://…')}" value="${esc(atuais[rede] || '')}" /></label>`;
      })
      .join('');
  }

  function renderRedes() {
    const disponiveis = redesDisponiveis();
    if (!disponiveis.length) {
      redesEl.innerHTML = '<p class="feed-sug-muted">O administrador ainda não liberou nenhuma rede (Configurações → Feed sugerido).</p>';
      iniciarBtn.disabled = true;
      return;
    }
    iniciarBtn.disabled = false;
    redesEl.innerHTML = disponiveis
      .map((p) => `<label class="feed-sug-rede"><input type="checkbox" name="feed-rede" value="${esc(p.id)}" ${disponiveis.length === 1 ? 'checked' : ''} />
        ${esc(p.nome)}${p.cookiesOk ? '' : ' <em title="Cookies desta rede com problema no servidor">cookies?</em>'}</label>`)
      .join('');
    qtdEl.max = String(config.maxPorRede);
    if (Number(qtdEl.value) > config.maxPorRede) qtdEl.value = String(config.maxPorRede);
    if (!temaEl.value && config.temaPadrao) temaEl.placeholder = `Ex.: ${config.temaPadrao}`;
    atualizarResumo();
  }

  async function carregarPaginas() {
    if (paginasCarregadas) return;
    try {
      const data = await api('/api/facebook/pages');
      const paginas = Array.isArray(data.pages) ? data.pages : [];
      paginaEl.innerHTML = paginas.length
        ? paginas
            .map((p) => `<option value="${esc(p.id)}" ${Number(p.id) === Number(data.default_facebook_page_id) ? 'selected' : ''}>${esc(p.page_name || p.name || `Página ${p.id}`)}</option>`)
            .join('')
        : '<option value="">Nenhuma página vinculada (as matérias ficam sem página)</option>';
      paginasCarregadas = true;
    } catch {
      // Mantém a "Página padrão": o servidor resolve a padrão da conta.
    }
  }

  function renderJob(job) {
    jobAtual = job;
    const ativo = ATIVOS.includes(job.status);
    form.hidden = ativo || job.status === 'concluido';
    jobEl.hidden = false;
    $('feed-sugerido-job-status').textContent = STATUS_JOB[job.status] || job.status;
    $('feed-sugerido-job-msg').textContent = job.mensagem || '';
    $('feed-sugerido-cancelar').hidden = !ativo;
    $('feed-sugerido-nova').hidden = ativo;

    const feitos = (job.concluidos || 0) + (job.falhas || 0);
    const pct = job.total ? Math.round((feitos / job.total) * 100) : job.status === 'coletando' ? 8 : 0;
    $('feed-sugerido-job-bar').style.width = `${ativo ? Math.max(pct, 4) : 100}%`;

    const nomes = Object.fromEntries((config?.plataformas || []).map((p) => [p.id, p.nome]));
    $('feed-sugerido-coleta').innerHTML = Object.entries(job.coleta || {})
      .map(([rede, c]) => {
        const nome = esc(nomes[rede] || rede);
        const base = `<b>${nome}:</b> ${c.novos || 0} vídeo(s) novo(s)` +
          (c.repetidos ? `, ${c.repetidos} já usado(s) antes` : '');
        const passos = (c.passos || []).length
          ? `<details class="feed-sug-passos"><summary>Ver passos</summary><code>${(c.passos || []).map(esc).join('<br>')}</code></details>`
          : '';
        return c.motivo
          ? `<li class="is-aviso">${base} — ${esc(c.motivo)}${passos}</li>`
          : `<li>${base}</li>`;
      })
      .join('');

    $('feed-sugerido-itens').innerHTML = (job.itens || [])
      .map((item) => {
        const [rotulo, classe] = STATUS_ITEM[item.status] || [item.status, ''];
        const titulo = item.materia_titulo || item.titulo || item.url;
        const detalhe = item.erro || item.etapa || `${nomes[item.plataforma] || item.plataforma}${item.autor ? ` · ${item.autor}` : ''}`;
        const thumb = item.thumbnail
          ? `<img class="feed-sug-thumb" src="${esc(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />`
          : '<span class="feed-sug-thumb"></span>';
        const badge = item.matter_id
          ? `<a class="feed-sug-badge ${classe}" href="/materias-ia/${esc(item.matter_id)}" target="_blank" rel="noopener">Abrir matéria</a>`
          : `<span class="feed-sug-badge ${classe}">${esc(rotulo)}</span>`;
        return `<li class="feed-sug-item">${thumb}
          <div class="feed-sug-item-body">
            <p title="${esc(titulo)}">${esc(titulo)}</p>
            <small title="${esc(detalhe)}"><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">vídeo</a> · ${esc(detalhe)}</small>
          </div>${badge}</li>`;
      })
      .join('');

    clearTimeout(timer);
    if (ativo) timer = setTimeout(() => acompanhar(job.id), 4000);
    else carregarHistorico();
  }

  async function acompanhar(id) {
    try {
      const { job } = await api(`/api/feed-sugerido/jobs/${encodeURIComponent(id)}`);
      if (!painel.classList.contains('hidden') || ATIVOS.includes(job.status)) renderJob(job);
    } catch (err) {
      $('feed-sugerido-job-msg').textContent = err.message;
      timer = setTimeout(() => acompanhar(id), 8000);
    }
  }

  async function carregarHistorico() {
    try {
      const { jobs } = await api('/api/feed-sugerido/jobs');
      const lista = (jobs || []).filter((j) => !jobAtual || j.id !== jobAtual.id).slice(0, 6);
      histEl.hidden = !lista.length;
      $('feed-sugerido-historico-lista').innerHTML = lista
        .map((j) => {
          const quando = new Date(j.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
          return `<li><button type="button" data-job="${esc(j.id)}"><span>${esc(quando)} · ${esc(j.plataformas.join(', '))}</span>
            <span>${esc(STATUS_JOB[j.status] || j.status)} · ${esc(j.concluidos)}/${esc(j.total)}</span></button></li>`;
        })
        .join('');
      return jobs || [];
    } catch {
      return [];
    }
  }

  function abrir(aberto) {
    painel.classList.toggle('hidden', !aberto);
    backdrop.classList.toggle('hidden', !aberto);
    backdrop.hidden = !aberto;
    if (!aberto) {
      clearTimeout(timer);
      return;
    }
    document.querySelectorAll('.mia-chat-more[open]').forEach((m) => m.removeAttribute('open'));
    erroEl.textContent = '';
    carregarPaginas();
    carregarHistorico().then((jobs) => {
      const ativo = jobs.find((j) => ATIVOS.includes(j.status));
      if (ativo) acompanhar(ativo.id);
      else if (jobAtual) acompanhar(jobAtual.id);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erroEl.textContent = '';
    const plataformas = redesMarcadas();
    if (!plataformas.length) {
      erroEl.textContent = 'Marque pelo menos uma rede.';
      return;
    }
    const links = {};
    linksEl.querySelectorAll('input[data-rede]').forEach((el) => {
      if (el.value.trim()) links[el.dataset.rede] = el.value.trim();
    });
    iniciarBtn.disabled = true;
    try {
      const { job } = await api('/api/feed-sugerido/jobs', {
        method: 'POST',
        body: JSON.stringify({
          plataformas,
          quantidade: Number(qtdEl.value) || 10,
          facebookPageId: paginaEl.value || null,
          tema: temaEl.value,
          tom: tomEl.value,
          pesquisarWeb: webEl.checked,
          links,
        }),
      });
      renderJob(job);
    } catch (err) {
      erroEl.textContent = err.message;
    } finally {
      iniciarBtn.disabled = false;
    }
  });

  redesEl.addEventListener('change', atualizarResumo);
  qtdEl.addEventListener('input', atualizarResumo);

  $('feed-sugerido-cancelar').addEventListener('click', async () => {
    if (!jobAtual || !confirm('Cancelar esta coleta? As matérias já criadas continuam salvas.')) return;
    try {
      const { job } = await api(`/api/feed-sugerido/jobs/${jobAtual.id}/cancelar`, { method: 'POST' });
      renderJob(job);
    } catch (err) {
      $('feed-sugerido-job-msg').textContent = err.message;
    }
  });

  $('feed-sugerido-nova').addEventListener('click', () => {
    jobAtual = null;
    jobEl.hidden = true;
    form.hidden = false;
    carregarHistorico();
  });

  $('feed-sugerido-historico-lista').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-job]');
    if (btn) acompanhar(btn.dataset.job);
  });

  painel.querySelector('[data-feed-sugerido-close]').addEventListener('click', () => abrir(false));
  backdrop.addEventListener('click', () => abrir(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !painel.classList.contains('hidden')) abrir(false);
  });

  // Só mostra os atalhos quando o admin liberou alguma rede.
  api('/api/feed-sugerido/config')
    .then((data) => {
      config = data;
      renderRedes();
      if (!redesDisponiveis().length) return;
      document.querySelectorAll('[data-feed-sugerido-open]').forEach((btn) => {
        btn.hidden = false;
        btn.addEventListener('click', () => abrir(true));
      });
    })
    .catch(() => {});
})();
