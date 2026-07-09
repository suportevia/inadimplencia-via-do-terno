/*
  Revisão 27 — Patch de desempenho Via do Terno
  Aplicar depois de index.js.
  Foco: reduzir travamentos sem alterar regras de cobrança, importação ou relatórios.
*/
(function(){
  'use strict';

  const REV = '27';
  const APP_LS_KEYS = new Set(['via_inadimplencia_pro_demo']);
  const HEAVY_IDS = new Set([
    'clientesBody','rankingBody','representantesBody',
    'autoAgenda129','autoAgenda3045','autoAgenda4659','autoAgenda60',
    'agendaPendentesBody','agendaConcluidosBody','crmAgendaBody','promessasBody',
    'kanbanBody','timelineBody','cobradoresBody','previewBody',
    'historicoClienteBody','historicoClienteBodyModal','historicoClienteSugestoesModal'
  ]);
  const SEARCH_IDS = new Set([
    'busca','timelineBusca','kanbanBusca','agendaPendentesSearch','agendaConcluidosSearch',
    'autoBusca129','autoBusca3045','autoBusca4659','autoBusca60',
    'buscaHistoricoCliente','buscaHistoricoClienteModal'
  ]);

  const idle = window.requestIdleCallback
    ? (fn, timeout=220) => window.requestIdleCallback(fn, {timeout})
    : (fn) => setTimeout(() => fn({timeRemaining:()=>8, didTimeout:true}), 16);

  const raf = window.requestAnimationFrame || ((fn)=>setTimeout(fn,16));

  function log(){
    if(window.localStorage && localStorage.getItem('r27_debug') === '1'){
      console.debug('[Revisão 27]', ...arguments);
    }
  }

  // 1) Evita congelamento por muitos localStorage.setItem gigantes seguidos.
  // O app grava o estado inteiro após snapshots; aqui mantemos a última gravação e descartamos repetidas iguais.
  (function otimizarLocalStorage(){
    const original = Storage.prototype.setItem;
    const pending = new Map();
    const lastHash = new Map();
    let scheduled = false;

    function hashFast(value){
      const s = String(value || '');
      // Hash parcial: suficiente para evitar gravação duplicada pesada.
      const sample = s.length + '|' + s.slice(0,256) + '|' + s.slice(Math.max(0, s.length-256));
      let h = 0;
      for(let i=0;i<sample.length;i++) h = ((h << 5) - h + sample.charCodeAt(i)) | 0;
      return String(h);
    }

    function flush(){
      scheduled = false;
      const jobs = Array.from(pending.entries());
      pending.clear();
      jobs.forEach(([storage, items])=>{
        items.forEach((value, key)=>{
          try{ original.call(storage, key, value); }catch(e){ console.warn('Falha ao gravar cache local:', e); }
        });
      });
    }

    Storage.prototype.setItem = function(key, value){
      try{
        if(APP_LS_KEYS.has(String(key)) && String(value || '').length > 90000){
          const h = hashFast(value);
          if(lastHash.get(key) === h) return;
          lastHash.set(key, h);
          if(!pending.has(this)) pending.set(this, new Map());
          pending.get(this).set(String(key), String(value));
          if(!scheduled){ scheduled = true; idle(flush, 350); }
          return;
        }
      }catch(e){ /* segue gravação normal */ }
      return original.call(this, key, value);
    };
  })();

  // 2) Debounce de pesquisas pesadas. Impede que a tela renderize a cada tecla.
  (function otimizarPesquisas(){
    const timers = new WeakMap();
    document.addEventListener('input', function(ev){
      const el = ev.target;
      if(!el || !SEARCH_IDS.has(el.id) || ev.__r27Debounced) return;
      ev.stopImmediatePropagation();
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(()=>{
        const e = new Event('input', {bubbles:true, cancelable:true});
        e.__r27Debounced = true;
        el.dispatchEvent(e);
      }, 220));
    }, true);
  })();

  // 3) Renderização progressiva em listas/tabelas grandes, evitando travar tudo de uma vez.
  (function otimizarInnerHTMLPesado(){
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if(!desc || !desc.set || !desc.get) return;
    const originalSet = desc.set;
    const originalGet = desc.get;
    const jobs = new WeakMap();

    function splitHtml(html, tag){
      const close = '</' + tag + '>';
      const parts = String(html).split(close);
      if(parts.length <= 2) return null;
      const chunks = [];
      for(let i=0;i<parts.length-1;i++) chunks.push(parts[i] + close);
      return chunks;
    }

    function chooseParts(el, html){
      if(el.tagName === 'TBODY') return splitHtml(html, 'tr');
      return splitHtml(html, 'article') || splitHtml(html, 'button') || null;
    }

    function progressiveSet(el, html){
      const old = jobs.get(el);
      if(old) old.cancelled = true;
      const parts = chooseParts(el, html);
      if(!parts || parts.length < 60){
        originalSet.call(el, html);
        return;
      }

      const job = {cancelled:false};
      jobs.set(el, job);
      originalSet.call(el, '');

      const batchSize = el.tagName === 'TBODY' ? 60 : 28;
      let i = 0;
      function step(){
        if(job.cancelled) return;
        const end = Math.min(i + batchSize, parts.length);
        let chunk = '';
        for(; i<end; i++) chunk += parts[i];
        el.insertAdjacentHTML('beforeend', chunk);
        if(i < parts.length) raf(step);
      }
      raf(step);
    }

    Object.defineProperty(Element.prototype, 'innerHTML', {
      get: function(){ return originalGet.call(this); },
      set: function(value){
        const html = String(value ?? '');
        if(this && HEAVY_IDS.has(this.id) && html.length > 55000){
          progressiveSet(this, html);
          return;
        }
        return originalSet.call(this, value);
      }
    });
  })();

  // 4) Conteúdo visível primeiro: deixa o navegador ignorar pintura fora da tela.
  (function marcarContainersPesados(){
    const apply = () => {
      HEAVY_IDS.forEach(id=>{
        const el = document.getElementById(id);
        if(el) el.classList.add('r27-perf-container');
      });
      document.body.classList.add('r27-performance-active');
    };
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, {once:true});
    else apply();
    const mo = new MutationObserver(()=>apply());
    mo.observe(document.documentElement, {childList:true, subtree:true});
  })();

  // 5) Indicador leve, útil para confirmar que o patch carregou.
  window.revisao27Performance = {
    version: REV,
    active: true,
    heavyContainers: Array.from(HEAVY_IDS),
    message: 'Revisão 27 de desempenho ativa.'
  };
  log('ativa');
})();
