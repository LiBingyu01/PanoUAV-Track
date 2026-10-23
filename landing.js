(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const domains = ['light','night','simulation'];
  const domainLabels = {light:'Daylight',night:'Nighttime',simulation:'Simulation'};
  const hero = $('.hero');
  const viewport = $('#mosaicViewport');
  const track = $('#mosaicTrack');
  const status = $('#galleryStatus');
  const interval = Math.max(500, Number(hero?.dataset.cycleMs) || 5000);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = !!navigator.connection?.saveData;

  // Exact names and output paths emitted by build_demo_gallery.py.
  const names = {
    light: [
      'DJI_light_0721_5','DJI_light_0721_56','DJI_light_0721_90',
      'DJI_light_0721_193','DJI_light_0721_328__kf000027',
      'YL-light-20260521_150555_164-2__kf000056',
      'YL-light-20260521_151251_168-12__kf000009',
      'YL-light-20260521_153013_175-2',
      'YL-light-20260604_153400_079-3','YL-light-20260611_154709_214'
    ],
    night: [
      'YL-night-20260723_191514_005-1','YL-night-20260723_193231_016',
      'YL-night-20260723_193451_531-5','YL-night-20260723_193640_022-1',
      'YL-night-20260723_195814_546','YL-night-20260723_200451_549-2',
      'YL-night-20260723_201118_555-1','YL-night-20260803_200937_934-2',
      'YL-night-20260803_205637_968-3','YL-night-20260803_205731_969-2'
    ],
    simulation: [
      'VID_A1_000125_S000446_E000496','VID_A1_000152_S001322_E001372',
      'VID_A1_000482_S000010_E000060','VID_A2_000031_S000395_E000445',
      'VID_A2_000079_S000103_E000153','VID_A2_000170_S000304_E000454',
      'VID_A3_000236_S000293_E000443','VID_B1_000005_S000695_E000845',
      'VID_B1_000030_S000245_E000395','VID_B2_000437_S000962_E001112'
    ]
  };
  const fallback = {sequences:domains.flatMap(category => names[category].map(name => {
    const id = `${category}-${name}`;
    return {id,category,name,video:`assets/gallery/videos/${id}.mp4`,
      poster:`assets/gallery/posters/${id}.jpg`,
      annotations:`assets/gallery/annotations/${id}.json`,fps:10,frames:0};
  }))};

  // If an MP4 is missing, the full-screen wall can preview the same JPG frames at
  // a low frame rate; the 360 viewer independently uses JPGs at the original FPS.
  let jpgIndex = null;
  const jpgTimers = new Map();
  const frameReady = location.protocol === 'file:'
    ? Promise.resolve(window.PANO_FRAMES_MANIFEST || null)
    : fetch('assets/gallery/frames-manifest.json').then(r=>r.ok?r.json():null)
        .catch(()=>window.PANO_FRAMES_MANIFEST || null);
  frameReady.then(data=>{jpgIndex=data?.sequences||null;
      $$('.video-tile').filter(tile=>tile.querySelector('video')?.dataset.fallback==='1')
        .forEach(tile=>{if(tile.closest('.video-page')===activeSection())beginJpgPreview(tile);});
    }).catch(()=>{});
  function beginJpgPreview(tile){
    if(jpgTimers.has(tile))return;
    const info=jpgIndex?.[tile.dataset.id];
    if(!info?.files?.length)return;
    tile.classList.add('has-jpg-preview');
    const badge=tile.querySelector('.tile-error');if(badge)badge.hidden=true;
    let frame=Number(tile.dataset.jpgIndex||0);
    let img=tile.querySelector('.tile-jpg-fallback');
    if(!img){img=document.createElement('img');img.className='tile-jpg-fallback';
      img.alt='';img.decoding='async';tile.insertBefore(img,tile.querySelector('.globe-entry'));}
    const change=()=>{
      const src=info.base.split('/').map(encodeURIComponent).join('/')+encodeURIComponent(info.files[frame%info.files.length]);
      img.src=src;frame++;tile.dataset.jpgIndex=String(frame);
    };
    change();jpgTimers.set(tile,setInterval(change,500)); // 2 FPS to limit simultaneous JPG traffic.
  }
  function stopJpgPreviews(){for(const t of jpgTimers.values())clearInterval(t);jpgTimers.clear();}
  let entries = [];
  let page = 0;
  let trackPage = 1;
  let animating = false;
  let modalOpen = false;
  let inView = true;
  let timer = null;
  let touchStart = null;
  let loaded = false;

  // Each tile is one actual muted video. Last/first seam pages provide a seamless wrap.
  function tileHTML(item) {
    if (!item) return '<div class="video-tile missing-video"></div>';
    return `<article class="video-tile" data-id="${safe(item.id)}" style="--poster-image:url('${safe(item.poster)}')">
      <video class="tile-video" muted playsinline loop preload="none" poster="${safe(item.poster)}" aria-label="${safe(item.name)}"></video>
      <button type="button" class="globe-entry" data-open="${safe(item.id)}" aria-label="Explore ${safe(item.name)} in interactive 360° view" title="Explore this clip in 360°">
        <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18"/><ellipse cx="24" cy="24" rx="8" ry="18"/><path d="M6 24h36M11 13c9 7 17 7 26 0M11 35c9-7 17-7 26 0"/></svg>
      </button>
      <span class="tile-hover-text" aria-hidden="true">点击探索 360° 视频 <small>EXPLORE 360°</small></span>
      <span class="tile-title">${safe(item.name)}</span>
      <span class="tile-error" hidden>Video not found</span>
    </article>`;
  }
  function pageHTML(category, clone = false) {
    const list = entries.filter(item => item.category === category).slice(0, 9);
    return `<section class="video-page${clone?' is-clone':''}" data-domain="${category}" aria-label="${domainLabels[category]}: nine videos"><div class="video-matrix">${Array.from({length:9}, (_,i) => tileHTML(list[i])).join('')}</div></section>`;
  }
  const allPages = () => $$('.video-page',track);
  function activeSection() { return allPages()[trackPage]; }
  function stopVideos() { $$('video.tile-video',track).forEach(video => video.pause()); stopJpgPreviews(); }

  function playVideos(section) {
    if (!section || document.hidden || !inView || modalOpen || saveData) return;
    // Ten simultaneous tracks can be expensive on weaker GPUs; preload only the visible group.
    $$('.video-tile',section).forEach(tile => {
      const video = $('video',tile);
      const item = entries.find(e => e.id === tile.dataset.id);
      if (!video || !item) return;
      if (video.dataset.fallback === '1') { beginJpgPreview(tile);return; }
      if (!video.dataset.loaded) {
        video.src = item.video;
        video.dataset.loaded = 'true';
      }
      video.muted = true;
      video.defaultMuted = true;
      video.play().catch(() => {});
    });
  }
  function syncButtons() {
    $$('.environment-tab').forEach((button,index) => {
      const selected = index === page;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected',String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    allPages().forEach((section,index) => {
      section.setAttribute('aria-hidden', String(index !== trackPage));
      section.inert = index !== trackPage;
    });
  }
  function makePages() {
    track.innerHTML = [pageHTML('simulation',true),
      ...domains.map(domain => pageHTML(domain)),pageHTML('light',true)].join('');
    trackPage = 1;
    track.style.transition = 'none';
    track.style.transform = 'translate3d(-100%,0,0)';
    // Force style recalculation before restoring the animation class.
    void track.offsetWidth;
    track.style.transition = '';
    $$('.video-tile video',track).forEach(video => {
      video.addEventListener('error',() => {
        const tile = video.closest('.video-tile');
        if (!tile) return;
        tile.classList.add('no-media');
        video.dataset.fallback='1';
        const err = $('.tile-error',tile);
        if(err)err.hidden=false;
        if (tile.closest('.video-page') === activeSection()) beginJpgPreview(tile);
      });
    });
    loaded = true;
    syncButtons();
    playVideos(activeSection());
    scheduleCycle();
  }
  function finish() {
    if (!animating) return;
    if (trackPage === 0 || trackPage === 4) {
      // Make the visually identical real page active without an animation.
      const wrapPage = page + 1;
      stopVideos();
      trackPage = wrapPage;
      track.style.transition = 'none';
      track.style.transform = `translate3d(-${trackPage*100}%,0,0)`;
      void track.offsetWidth;
      track.style.transition = '';
    }
    animating = false;
    syncButtons();
    stopVideos();
    playVideos(activeSection());
  }
  function move(step) {
    if (!loaded || animating || modalOpen) return;
    page = (page + step + domains.length) % domains.length;
    trackPage += step;
    animating = true;
    syncButtons();
    // Playback switches only after animation so the outgoing wall continues moving.
    // Incoming tile posters are visible during transition, without a 20-video decode spike.
    track.style.transform = `translate3d(-${trackPage*100}%,0,0)`;
    if (reducedMotion) {
      finish();
    }
  }
  function selectPage(index) {
    if (index === page) { scheduleCycle();return; }
    // The group has three members, so every destination is one neighboring move.
    const step = index === (page + 1) % 3 ? 1 : -1;
    move(step);
    scheduleCycle();
  }
  function scheduleCycle() {
    window.clearInterval(timer);
    timer = null;
    if (!loaded || modalOpen || !inView || document.hidden || reducedMotion) return;
    timer = window.setInterval(() => move(1), interval);
  }
  track.addEventListener('transitionend',e => {
    if (e.target === track && e.propertyName === 'transform') finish();
  });
  track.addEventListener('click',e => {
    const button = e.target.closest('[data-open]');
    if (!button) return;
    const item = entries.find(entry => entry.id === button.dataset.open);
    if (item) { const tile=button.closest('.video-tile'); const v=tile?.querySelector('video'); window.Pano360?.open({...item, preferredVideoSrc: v?.readyState >= 2 ? (v.currentSrc || v.src) : undefined}); }
  });
  $('#slidePrev').addEventListener('click',() => {move(-1);scheduleCycle();});
  $('#slideNext').addEventListener('click',() => {move(1);scheduleCycle();});
  $$('.environment-tab').forEach(button => button.addEventListener('click',() => selectPage(Number(button.dataset.slide))));
  viewport.addEventListener('keydown',e => {
    if(e.key === 'ArrowLeft') {e.preventDefault();move(-1);scheduleCycle();}
    if(e.key === 'ArrowRight') {e.preventDefault();move(1);scheduleCycle();}
  });
  viewport.addEventListener('pointerdown',e => {
    if(e.target.closest('button'))return;
    touchStart = {x:e.clientX,y:e.clientY};
  });
  viewport.addEventListener('pointerup',e => {
    if(!touchStart)return;
    const dx=e.clientX-touchStart.x;
    const dy=e.clientY-touchStart.y;
    touchStart=null;
    if(Math.abs(dx)>55 && Math.abs(dx)>Math.abs(dy)*1.4) {move(dx<0?1:-1);scheduleCycle();}
  });
  viewport.addEventListener('pointercancel',() => touchStart=null);
  document.addEventListener('keydown',e => {
    if (modalOpen || !inView || e.target.closest('input,textarea,button')) return;
    if(e.key === 'ArrowLeft') {e.preventDefault();move(-1);scheduleCycle();}
    if(e.key === 'ArrowRight') {e.preventDefault();move(1);scheduleCycle();}
  });
  window.addEventListener('pano:open',() => {
    modalOpen=true;
    window.clearInterval(timer);
    timer=null;
    stopVideos();
  });
  window.addEventListener('pano:close',() => {
    modalOpen=false;
    if (!animating) playVideos(activeSection());
    scheduleCycle();
  });
  document.addEventListener('visibilitychange',() => {
    if (document.hidden) {stopVideos();window.clearInterval(timer);timer=null;}
    else {if(!animating)playVideos(activeSection());scheduleCycle();}
  });
  const observer = new IntersectionObserver(records => {
    for (const record of records) {
      inView = record.isIntersecting;
      if(!inView)stopVideos();
      else if(!animating)playVideos(activeSection());
      scheduleCycle();
    }
  },{threshold:0.04});
  observer.observe(hero);

  $('#copyCitation')?.addEventListener('click',async() => {
    const citation=$('#bibtex')?.textContent||'';
    try { await navigator.clipboard.writeText(citation);$('#citationFeedback').textContent='Copied'; }
    catch {$('#citationFeedback').textContent='Select and copy the text above'; }
  });

  const ready = location.protocol === 'file:' ? Promise.resolve(window.PANO_GALLERY_MANIFEST || fallback)
    : fetch('assets/gallery/manifest.json',{cache:'no-store'})
      .then(response => response.ok ? response.json() : Promise.reject(Error(`HTTP ${response.status}`)))
      .catch(() => window.PANO_GALLERY_MANIFEST || fallback);
  ready.then(data => {
    const discovered=Array.isArray(data?.sequences)?data.sequences:fallback.sequences;
    entries=domains.flatMap(category => names[category].map(name =>
      discovered.find(entry => entry.category === category && entry.name === name)
      || fallback.sequences.find(entry => entry.category === category && entry.name === name)));
    if(entries.length !== 30) throw Error(`Expected 30 sequences; found ${entries.length}`);
    makePages();
  }).catch(error => {
    status.textContent = `Gallery could not load: ${String(error?.message||error)}`;
  });
})();
