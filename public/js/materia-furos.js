/**
 * Furos do dia (/materia-manual): busca o que está quente no nicho no Google
 * News, YouTube e nos perfis do Instagram/Facebook monitorados pela
 * Biblioteca, ordena pelo potencial de repercussão e gera várias matérias em
 * sequência. Vídeos e posts são escritos em segundo plano (transcrição pelo
 * mesmo fluxo do chat) e o painel acompanha cada um.
 */
(function () {
  const dialog = document.getElementById('furos-dialog');
  if (!dialog) return;

  const API = '/api/materias-ia/chat-extras/furos';
  const NICHOS_KEY = 'ViralizeAI.furosNichos';
  const CANAIS_KEY = 'ViralizeAI.furosCanais';
  const LIMITE_KEY = 'ViralizeAI.furosLimite';
  const MAX_LOTE = 12;
  const ROTULO_CANAL = { noticias: 'Notícia', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };
  const ESPERA_REDE_MS = 15 * 60 * 1000;

  const el = {
    backdrop: document.getElementById('furos-backdrop'),
    fechar: document.getElementById('furos-fechar'),
    nichos: document.getElementById('furos-nichos'),
    buscar: document.getElementById('furos-buscar'),
    status: document.getElementById('furos-status'),
    lista: document.getElementById('furos-lista'),
    top: document.getElementById('furos-top'),
    gerar: document.getElementById('furos-gerar'),
    horas: dialog.querySelectorAll('[data-furos-horas]'),
    canais: dialog.querySelectorAll('[data-furos-canal]'),
    limite: document.getElementById('furos-limite'),
  };

  const state = {
    nichos: [],
    sugeridos: [],
    selecionados: new Set(['auto']),
    canais: new Set(['noticias', 'youtube', 'instagram', 'facebook']),
    horas: 24,
    furos: [],
    marcados: new Set(),
    resultados: new Map(),
    buscando: false,
    gerando: false,
    parar: false,
    ultimoFoco: null,
  };

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function setStatus(texto, tipo = '') {
    el.status.textContent = texto || '';
    el.status.dataset.tipo = tipo;
  }

  /* ---------------------------- abrir / fechar ---------------------------- */

  function abrir() {
    state.ultimoFoco = document.activeElement;
    dialog.hidden = false;
    el.backdrop.hidden = false;
    document.body.classList.add('mia-furos-aberto');
    if (!state.nichos.length) carregarNichos();
    el.buscar.focus();
  }

  function fechar() {
    if (state.gerando && !confirm('As matérias ainda estão sendo geradas. Fechar interrompe o lote após a matéria atual. Fechar mesmo assim?')) return;
    state.parar = true;
    dialog.hidden = true;
    el.backdrop.hidden = true;
    document.body.classList.remove('mia-furos-aberto');
    state.ultimoFoco?.focus?.();
  }

  document.querySelectorAll('.mia-furos-open').forEach((botao) => botao.addEventListener('click', abrir));
  el.fechar.addEventListener('click', fechar);
  el.backdrop.addEventListener('click', fechar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dialog.hidden) fechar();
  });

  /* -------------------------------- nichos -------------------------------- */

  function lerNichosSalvos() {
    try {
      const salvos = JSON.parse(localStorage.getItem(NICHOS_KEY) || '[]');
      return Array.isArray(salvos) && salvos.length ? salvos : null;
    } catch {
      return null;
    }
  }

  function salvarNichos() {
    try { localStorage.setItem(NICHOS_KEY, JSON.stringify([...state.selecionados])); } catch { /* ignore */ }
  }

  function renderNichos() {
    el.nichos.replaceChildren();
    const rotuloAuto = state.sugeridos.length
      ? `Automático · ${state.sugeridos
          .map((id) => state.nichos.find((n) => n.id === id)?.rotulo)
          .filter(Boolean)
          .join(', ')}`
      : 'Automático';
    const opcoes = [{ id: 'auto', rotulo: rotuloAuto }, ...state.nichos];
    for (const nicho of opcoes) {
      const chip = document.createElement('button');
      const ativo = state.selecionados.has(nicho.id);
      chip.type = 'button';
      chip.className = `mia-furos-chip${nicho.id === 'auto' ? ' is-auto' : ''}${ativo ? ' is-active' : ''}`;
      chip.setAttribute('aria-pressed', String(ativo));
      chip.textContent = nicho.rotulo;
      if (nicho.id === 'auto') chip.title = 'Usa os nichos das matérias que você mais produz';
      chip.addEventListener('click', () => {
        if (nicho.id === 'auto') {
          state.selecionados = new Set(['auto']);
        } else {
          state.selecionados.delete('auto');
          if (state.selecionados.has(nicho.id)) state.selecionados.delete(nicho.id);
          else if (state.selecionados.size < 4) state.selecionados.add(nicho.id);
          else setStatus('Escolha até 4 nichos por busca.', 'aviso');
          if (!state.selecionados.size) state.selecionados.add('auto');
        }
        salvarNichos();
        renderNichos();
      });
      el.nichos.appendChild(chip);
    }
  }

  async function carregarNichos() {
    try {
      const data = await api(`${API}/nichos`);
      state.nichos = data.nichos || [];
      state.sugeridos = data.sugeridos || [];
      const salvos = lerNichosSalvos();
      const validos = new Set(['auto', ...state.nichos.map((n) => n.id)]);
      if (salvos) state.selecionados = new Set(salvos.filter((id) => validos.has(id)));
      if (!state.selecionados.size) state.selecionados = new Set(['auto']);
      renderNichos();
    } catch (err) {
      setStatus(err.message, 'erro');
    }
  }

  function lerSalvo(chave) {
    try {
      return JSON.parse(localStorage.getItem(chave) || 'null');
    } catch {
      return null;
    }
  }

  function salvar(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* ignore */ }
  }

  function renderCanais() {
    el.canais.forEach((botao) => {
      const ativo = state.canais.has(botao.dataset.furosCanal);
      botao.classList.toggle('is-active', ativo);
      botao.setAttribute('aria-pressed', String(ativo));
    });
  }

  const canaisSalvos = lerSalvo(CANAIS_KEY);
  if (Array.isArray(canaisSalvos) && canaisSalvos.length) {
    state.canais = new Set(canaisSalvos.filter((c) => ROTULO_CANAL[c]));
    if (!state.canais.size) state.canais = new Set(Object.keys(ROTULO_CANAL));
  }
  renderCanais();
  el.canais.forEach((botao) => {
    botao.addEventListener('click', () => {
      const canal = botao.dataset.furosCanal;
      if (state.canais.has(canal) && state.canais.size === 1) {
        setStatus('Deixe pelo menos uma fonte marcada.', 'aviso');
        return;
      }
      if (state.canais.has(canal)) state.canais.delete(canal);
      else state.canais.add(canal);
      salvar(CANAIS_KEY, [...state.canais]);
      renderCanais();
    });
  });

  const limiteSalvo = Number(lerSalvo(LIMITE_KEY));
  if (el.limite && [15, 25, 40].includes(limiteSalvo)) el.limite.value = String(limiteSalvo);
  el.limite?.addEventListener('change', () => salvar(LIMITE_KEY, Number(el.limite.value) || 25));

  el.horas.forEach((botao) => {
    botao.addEventListener('click', () => {
      state.horas = Number(botao.dataset.furosHoras) || 24;
      el.horas.forEach((b) => {
        const ativo = b === botao;
        b.classList.toggle('is-active', ativo);
        b.setAttribute('aria-pressed', String(ativo));
      });
    });
  });

  /* -------------------------------- busca -------------------------------- */

  function tempoRelativo(ts) {
    if (!ts) return '';
    const min = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (min < 60) return `há ${min} min`;
    const horas = Math.round(min / 60);
    return horas < 48 ? `há ${horas}h` : `há ${Math.round(horas / 24)} dias`;
  }

  function nivel(score) {
    if (score >= 45) return { rotulo: 'Bombástica', classe: 'is-bomba' };
    if (score >= 25) return { rotulo: 'Quente', classe: 'is-quente' };
    return { rotulo: 'Morna', classe: 'is-morna' };
  }

  function atualizarAcoes() {
    const total = state.marcados.size;
    el.top.disabled = state.gerando || !state.furos.length;
    el.gerar.disabled = state.gerando || !total;
    el.gerar.textContent = state.gerando
      ? 'Gerando…'
      : total
        ? `Gerar ${total} matéria${total > 1 ? 's' : ''}`
        : 'Gerar matérias';
  }

  function renderResultado(card, indice) {
    const alvo = card.querySelector('.mia-furo-resultado');
    const r = state.resultados.get(indice);
    alvo.replaceChildren();
    card.dataset.estado = r?.estado || '';
    if (!r) return;
    if (r.estado === 'fila') alvo.textContent = 'Na fila';
    if (r.estado === 'gerando') alvo.textContent = r.etapa || 'Escrevendo a matéria…';
    if (r.estado === 'erro') alvo.textContent = r.erro;
    if (r.estado === 'ok') {
      const link = document.createElement('a');
      link.href = r.redirect;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `Rascunho #${r.matterId} — abrir para revisar`;
      alvo.appendChild(link);
    }
  }

  function renderFuros() {
    el.lista.replaceChildren();
    state.furos.forEach((furo, indice) => {
      const card = document.createElement('article');
      card.className = 'mia-furo';
      const n = nivel(furo.score);

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'mia-furo-check';
      check.checked = state.marcados.has(indice);
      check.disabled = state.gerando || state.resultados.get(indice)?.estado === 'ok';
      check.setAttribute('aria-label', `Gerar matéria: ${furo.titulo}`);
      check.addEventListener('change', () => {
        if (check.checked && state.marcados.size >= MAX_LOTE) {
          check.checked = false;
          setStatus(`Até ${MAX_LOTE} matérias por lote.`, 'aviso');
          return;
        }
        if (check.checked) state.marcados.add(indice);
        else state.marcados.delete(indice);
        card.classList.toggle('is-marcado', check.checked);
        atualizarAcoes();
      });
      card.classList.toggle('is-marcado', check.checked);

      const thumb = document.createElement('div');
      thumb.className = 'mia-furo-thumb';
      if (furo.imagem) {
        const img = document.createElement('img');
        img.src = furo.imagem;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove());
        thumb.appendChild(img);
      }

      const corpo = document.createElement('div');
      corpo.className = 'mia-furo-corpo';
      const titulo = document.createElement('a');
      titulo.className = 'mia-furo-titulo';
      titulo.href = furo.url;
      titulo.target = '_blank';
      titulo.rel = 'noopener';
      titulo.textContent = furo.titulo;
      const meta = document.createElement('p');
      meta.className = 'mia-furo-meta';
      if (furo.canal && furo.canal !== 'noticias') {
        const selo = document.createElement('span');
        selo.className = `mia-furo-canal is-${furo.canal}`;
        selo.textContent = ROTULO_CANAL[furo.canal] || furo.canal;
        meta.appendChild(selo);
      }
      meta.append([
        furo.veiculo,
        furo.veiculos?.length > 1 ? `+${furo.veiculos.length - 1} veículos` : null,
        tempoRelativo(furo.dataTimestamp),
        furo.nicho,
      ].filter(Boolean).join(' · '));
      const motivos = document.createElement('div');
      motivos.className = 'mia-furo-motivos';
      for (const motivo of furo.motivos || []) {
        const tag = document.createElement('span');
        tag.textContent = motivo;
        motivos.appendChild(tag);
      }
      const resultado = document.createElement('p');
      resultado.className = 'mia-furo-resultado';
      resultado.setAttribute('aria-live', 'polite');
      corpo.append(titulo, meta, motivos, resultado);

      const nota = document.createElement('div');
      nota.className = `mia-furo-nota ${n.classe}`;
      nota.title = `Potencial de repercussão: ${furo.score}/100`;
      const numero = document.createElement('strong');
      numero.textContent = furo.score;
      const rotulo = document.createElement('small');
      rotulo.textContent = n.rotulo;
      nota.append(numero, rotulo);

      card.append(check, thumb, corpo, nota);
      el.lista.appendChild(card);
      renderResultado(card, indice);
    });
  }

  async function buscar() {
    if (state.buscando || state.gerando) return;
    state.buscando = true;
    state.furos = [];
    state.marcados.clear();
    state.resultados.clear();
    el.buscar.disabled = true;
    el.lista.replaceChildren();
    for (let i = 0; i < 4; i += 1) {
      const esqueleto = document.createElement('div');
      esqueleto.className = 'mia-furo is-esqueleto';
      el.lista.appendChild(esqueleto);
    }
    setStatus('Varrendo Google News, YouTube e as páginas monitoradas… leva uns 30 segundos.');
    atualizarAcoes();
    try {
      const data = await api(`${API}/buscar`, {
        method: 'POST',
        body: JSON.stringify({
          nichos: [...state.selecionados],
          horas: state.horas,
          limite: Number(el.limite?.value) || 25,
          canais: [...state.canais],
        }),
      });
      state.furos = data.furos || [];
      renderFuros();
      const nichos = (data.nichos || []).map((n) => n.rotulo).join(', ');
      const porCanal = Object.entries(data.porCanal || {})
        .map(([canal, total]) => `${total} ${canal === 'noticias' ? 'notícias' : ROTULO_CANAL[canal] || canal}`)
        .join(', ');
      const avisos = (data.avisos || []).length ? ` · ${data.avisos.join(' · ')}` : '';
      setStatus(
        state.furos.length
          ? `${state.furos.length} pautas em ${nichos}${porCanal ? ` (${porCanal})` : ''} · últimas ${data.horas}h${data.totalOcultado ? ` · ${data.totalOcultado} já viraram matéria e foram escondidas` : ''}${avisos}.`
          : `Nada novo em ${nichos} nas últimas ${data.horas}h. Tente 48h, outro nicho ou mais fontes.${avisos}`,
        state.furos.length ? '' : 'aviso'
      );
    } catch (err) {
      el.lista.replaceChildren();
      setStatus(err.message, 'erro');
    } finally {
      state.buscando = false;
      el.buscar.disabled = false;
      atualizarAcoes();
    }
  }

  el.buscar.addEventListener('click', buscar);

  el.top.addEventListener('click', () => {
    state.marcados = new Set(
      state.furos
        .map((_, i) => i)
        .filter((i) => state.resultados.get(i)?.estado !== 'ok')
        .slice(0, 5)
    );
    renderFuros();
    atualizarAcoes();
  });

  /* -------------------------------- lote -------------------------------- */

  function atualizarCard(indice) {
    const card = el.lista.children[indice];
    if (card) renderResultado(card, indice);
  }

  function modeloEscolhido() {
    return document.getElementById('chat-ai-model')?.dataset.modelo || null;
  }

  /** Acompanha a geração de vídeo/post das redes até terminar. */
  async function acompanharGeracao(indice, jobId) {
    const limite = Date.now() + ESPERA_REDE_MS;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 3000));
      const res = await fetch(`${API}/gerar/${encodeURIComponent(jobId)}`, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) throw new Error(data.error || 'Não foi possível acompanhar a matéria.');
      if (data.estado === 'ok') return data;
      if (data.estado === 'erro') throw new Error(data.erro || 'A matéria não foi escrita.');
      state.resultados.set(indice, { estado: 'gerando', etapa: data.etapa });
      atualizarCard(indice);
    }
    throw new Error('A matéria ainda está sendo escrita. Confira em Matérias salvas daqui a pouco.');
  }

  el.gerar.addEventListener('click', async () => {
    const fila = [...state.marcados].sort((a, b) => a - b);
    if (!fila.length || state.gerando) return;
    state.gerando = true;
    state.parar = false;
    fila.forEach((i) => state.resultados.set(i, { estado: 'fila' }));
    renderFuros();
    atualizarAcoes();

    let ok = 0;
    for (let passo = 0; passo < fila.length; passo += 1) {
      if (state.parar) break;
      const indice = fila[passo];
      state.resultados.set(indice, { estado: 'gerando' });
      atualizarCard(indice);
      setStatus(`Escrevendo matéria ${passo + 1} de ${fila.length}…`);
      try {
        let data = await api(`${API}/gerar`, {
          method: 'POST',
          body: JSON.stringify({ pauta: state.furos[indice], modelo: modeloEscolhido() }),
        });
        if (data.jobId) {
          state.resultados.set(indice, { estado: 'gerando', etapa: 'Lendo o vídeo e transcrevendo…' });
          atualizarCard(indice);
          data = await acompanharGeracao(indice, data.jobId);
        }
        state.resultados.set(indice, { estado: 'ok', matterId: data.matterId, redirect: data.redirect });
        ok += 1;
      } catch (err) {
        state.resultados.set(indice, { estado: 'erro', erro: err.message });
      }
      atualizarCard(indice);
    }

    state.gerando = false;
    state.marcados.clear();
    renderFuros();
    atualizarAcoes();
    const falhas = fila.filter((i) => state.resultados.get(i)?.estado === 'erro').length;
    setStatus(
      `${ok} rascunho${ok === 1 ? '' : 's'} criado${ok === 1 ? '' : 's'}${falhas ? ` · ${falhas} falha${falhas > 1 ? 's' : ''}` : ''}. Todos ficam em Matérias salvas.`,
      ok ? 'ok' : 'erro'
    );
  });

  // /materia-manual?furos=1 (link da página Piloto automático) abre o painel.
  if (new URLSearchParams(location.search).get('furos') === '1') abrir();
})();
