/**
 * Furos do dia no piloto automático (/materia-manual).
 *
 * Liga/desliga o piloto e mostra o que ele está fazendo: fila, escrita,
 * imagens em geração, prontas e publicadas. Os nichos, fontes e período vêm
 * dos filtros do próprio painel do Furos (gravados no navegador).
 */
(function () {
  const secao = document.getElementById('furos-auto');
  const dialog = document.getElementById('furos-dialog');
  if (!secao || !dialog) return;

  const API = '/api/materias-ia/chat-extras/furos/auto';
  const $ = (id) => document.getElementById(id);
  const el = {
    ativo: $('furos-auto-ativo'),
    intervalo: $('furos-auto-intervalo'),
    pagina: $('furos-auto-pagina'),
    limite: $('furos-auto-limite'),
    foto: $('furos-auto-foto'),
    salvar: $('furos-auto-salvar'),
    escanear: $('furos-auto-escanear'),
    resumo: $('furos-auto-resumo'),
    itens: $('furos-auto-itens'),
  };

  const ETAPAS = {
    na_fila: ['Na fila', 'is-fila'],
    escrevendo: ['Escrevendo', 'is-andamento'],
    aguardando_imagem: ['Aguardando imagem', 'is-fila'],
    gerando_imagem: ['Gerando imagem com IA', 'is-andamento'],
    pronta: ['Pronta para publicar', 'is-pronta'],
    publicando: ['Publicando', 'is-andamento'],
    publicada: ['Publicada', 'is-publicada'],
    erro: ['Não publicada', 'is-erro'],
  };
  const CANAL = { noticias: 'Notícia', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

  let timer = null;
  let paginasCarregadas = false;
  let ultimoStatus = null;

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status})`);
    return data;
  }

  function lerSalvo(chave, padrao) {
    try {
      const valor = JSON.parse(localStorage.getItem(chave) || 'null');
      return Array.isArray(valor) && valor.length ? valor : padrao;
    } catch {
      return padrao;
    }
  }

  /** Mesmos filtros que o editor marcou no painel do Furos. */
  function filtrosDoPainel() {
    const horas = Number(dialog.querySelector('[data-furos-horas].is-active')?.dataset.furosHoras) || 24;
    return {
      nichos: lerSalvo('ViralizeAI.furosNichos', ['auto']),
      canais: lerSalvo('ViralizeAI.furosCanais', ['noticias', 'youtube', 'instagram', 'facebook']),
      horas,
    };
  }

  function hora(valor) {
    if (!valor) return '';
    const data = new Date(valor);
    if (Number.isNaN(data.getTime())) return '';
    return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function carregarPaginas(selecionada) {
    if (!paginasCarregadas) {
      try {
        const data = await api('/api/facebook/pages');
        const paginas = Array.isArray(data.pages) ? data.pages : [];
        el.pagina.replaceChildren();
        if (!paginas.length) el.pagina.append(new Option('Nenhuma página vinculada', ''));
        for (const p of paginas) {
          const opcao = new Option(p.page_name || p.name || `Página ${p.id}`, String(p.id));
          if (Number(p.id) === Number(data.default_facebook_page_id)) opcao.selected = true;
          el.pagina.append(opcao);
        }
        paginasCarregadas = true;
      } catch {
        // mantém "Página padrão"
      }
    }
    if (selecionada) el.pagina.value = String(selecionada);
  }

  function setResumo(texto, tipo = '') {
    el.resumo.textContent = texto || '';
    el.resumo.dataset.tipo = tipo;
  }

  function render(status) {
    ultimoStatus = status;
    const { config, contagens = {}, publicadasHoje = 0 } = status;
    el.ativo.checked = Boolean(config.ativo);
    el.intervalo.value = String(config.intervalo_minutos || 10);
    el.limite.value = String(config.limite_dia || 40);
    if (![...el.limite.options].some((o) => o.value === el.limite.value)) {
      el.limite.append(new Option(String(config.limite_dia), String(config.limite_dia)));
      el.limite.value = String(config.limite_dia);
    }
    el.foto.checked = config.foto_original_se_falhar !== false;
    el.escanear.hidden = !config.ativo;
    secao.classList.toggle('is-ativo', Boolean(config.ativo));

    if (!config.ativo) {
      setResumo(publicadasHoje ? `Desligado · ${publicadasHoje} publicada(s) hoje.` : 'Desligado. Marque “Automatizar” para a IA trabalhar sozinha.');
    } else {
      const imagens = (contagens.gerando_imagem || 0);
      const partes = [
        `Ligado · posta a cada ${config.intervalo_minutos} min`,
        config.proxima_postagem_at && new Date(config.proxima_postagem_at) > new Date()
          ? `próxima postagem às ${hora(config.proxima_postagem_at)}`
          : 'publica a próxima assim que ficar pronta',
        status.escaneandoAgora ? 'procurando pautas agora…' : status.proximoScan ? `próxima varredura às ${hora(status.proximoScan)}` : 'varrendo em instantes',
        `${publicadasHoje}/${config.limite_dia} hoje`,
        `fila ${contagens.na_fila || 0}`,
        `escrevendo ${contagens.escrevendo || 0}`,
        `imagem ${imagens}/${status.maxImagens || 2} (+${contagens.aguardando_imagem || 0} aguardando)`,
        `prontas ${contagens.pronta || 0}`,
      ];
      setResumo(partes.join(' · ') + (config.ultimo_erro ? `\nÚltimo problema: ${config.ultimo_erro}` : ''), config.ultimo_erro ? 'aviso' : 'ok');
    }

    el.itens.replaceChildren();
    for (const item of status.itens || []) {
      const [rotulo, classe] = ETAPAS[item.status] || [item.status, ''];
      const li = document.createElement('li');
      li.className = `mia-furos-auto-item ${classe}`;

      const corpo = document.createElement('div');
      const titulo = document.createElement('a');
      titulo.href = item.matter_id ? `/materias-ia/${item.matter_id}` : item.url;
      titulo.target = '_blank';
      titulo.rel = 'noopener';
      titulo.textContent = String(item.materia_titulo || item.titulo || item.url).replace(/\[\[|\]\]|\*\*/g, '');
      const meta = document.createElement('small');
      meta.textContent = [
        CANAL[item.canal] || item.canal,
        item.nota_ia != null ? `nota ${item.nota_ia}` : null,
        item.status === 'publicada' && item.publicado_at ? `às ${hora(item.publicado_at)}` : null,
        item.status === 'pronta' || item.status === 'publicada' ? (item.imagem_ia ? 'imagem IA' : 'foto original') : null,
        item.erro || item.motivo,
      ].filter(Boolean).join(' · ');
      corpo.append(titulo, meta);

      const selo = document.createElement('span');
      selo.className = 'mia-furos-auto-selo';
      selo.textContent = rotulo;
      li.append(corpo, selo);

      if (['na_fila', 'aguardando_imagem', 'pronta'].includes(item.status)) {
        const tirar = document.createElement('button');
        tirar.type = 'button';
        tirar.className = 'mia-furos-auto-tirar';
        tirar.title = 'Tirar da fila (não publica)';
        tirar.setAttribute('aria-label', 'Tirar da fila');
        tirar.textContent = '×';
        tirar.addEventListener('click', async () => {
          tirar.disabled = true;
          try {
            render(await api(`${API}/itens/${item.id}/descartar`, { method: 'POST' }));
          } catch (err) {
            setResumo(err.message, 'erro');
            tirar.disabled = false;
          }
        });
        li.append(tirar);
      }
      el.itens.append(li);
    }
  }

  async function atualizar() {
    try {
      const status = await api(API);
      await carregarPaginas(status.config.facebook_page_id);
      render(status);
    } catch (err) {
      setResumo(err.message, 'erro');
    }
  }

  async function salvar(ativo) {
    el.salvar.disabled = true;
    el.ativo.disabled = true;
    try {
      const status = await api(API, {
        method: 'PUT',
        body: JSON.stringify({
          ...filtrosDoPainel(),
          ativo,
          intervalo_minutos: Number(el.intervalo.value) || 10,
          limite_dia: Number(el.limite.value) || 40,
          facebook_page_id: el.pagina.value || null,
          foto_original_se_falhar: el.foto.checked,
          modelo: document.getElementById('chat-ai-model')?.dataset.modelo || null,
        }),
      });
      render(status);
      if (ativo) setTimeout(atualizar, 3000);
    } catch (err) {
      el.ativo.checked = Boolean(ultimoStatus?.config?.ativo);
      setResumo(err.message, 'erro');
    } finally {
      el.salvar.disabled = false;
      el.ativo.disabled = false;
    }
  }

  el.ativo.addEventListener('change', () => {
    if (el.ativo.checked && !confirm(
      'Ligar o piloto automático?\n\nA IA vai escolher as pautas, escrever, gerar a imagem e PUBLICAR na página sozinha, ' +
      `uma a cada ${el.intervalo.value} min (até ${el.limite.value} por dia).`
    )) {
      el.ativo.checked = false;
      return;
    }
    salvar(el.ativo.checked);
  });
  el.salvar.addEventListener('click', () => salvar(el.ativo.checked));
  el.escanear.addEventListener('click', async () => {
    el.escanear.disabled = true;
    try {
      render(await api(`${API}/escanear`, { method: 'POST' }));
      setTimeout(atualizar, 5000);
    } catch (err) {
      setResumo(err.message, 'erro');
    } finally {
      el.escanear.disabled = false;
    }
  });

  // Atualiza enquanto o painel do Furos estiver aberto.
  new MutationObserver(() => {
    clearInterval(timer);
    if (!dialog.hidden) {
      atualizar();
      timer = setInterval(atualizar, 10_000);
    }
  }).observe(dialog, { attributes: true, attributeFilter: ['hidden'] });
})();
