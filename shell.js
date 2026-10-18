// Player page: boots the WebAssembly engine and gives it what a desktop
// install would have had on disk — assets on demand, saves, movies, input.
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const gameId = params.get('game') || 'question';
  const debug = params.has('debug') ? (...args) => console.log('[shell]', ...args) : () => {};
  const source = window.ponsSource; // where the game's files and saves are: source.js
  const GAME_DIR = '/game';
  const SAVE_DIR = `${GAME_DIR}/saves`;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const frame = $('frame');
  const canvas = $('canvas');
  const touchLayer = $('touch');
  const video = $('video');
  const busy = $('busy');
  const controls = $('controls');
  const boot = $('boot');
  const bootStatus = $('boot-status');
  const bootError = $('boot-error');
  const startButton = $('start');

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let Module = null;
  let preload = null;

  function fail(message) {
    boot.hidden = false;
    startButton.hidden = true;
    bootStatus.textContent = 'Something went wrong.';
    bootError.hidden = false;
    bootError.textContent = String(message);
  }

  // ---------------------------------------------------------------- layout

  const touchDevice = matchMedia('(pointer: coarse)').matches;
  const turnButton = controls.querySelector('[data-action="turn"]');
  let turned = false; // the reader's choice, kept from one visit to the next
  try {
    turned = localStorage.getItem('umineko.turned') === '1';
  } catch (err) { /* private browsing */ }
  document.body.classList.toggle('no-controls', !touchDevice);

  /**
   * Scales the picture to the largest size that fits beside the controls.
   * The game is 4:3 and a phone screen much wider, so the screen's short side
   * is what limits the picture. A phone held upright gives that side in full
   * (the browser's bars are on the other one): there the Turn button turns
   * the stage a quarter, and the reader turns the phone instead of the screen.
   */
  function layout() {
    const portrait = innerHeight > innerWidth;
    const rotated = portrait && touchDevice && turned;
    turnButton.hidden = !portrait;
    turnButton.classList.toggle('on', rotated);
    document.body.classList.toggle('rotated', rotated);
    document.body.classList.toggle('portrait', portrait && !rotated);
    stage.style.width = rotated ? `${innerHeight}px` : '';
    stage.style.height = rotated ? `${innerWidth}px` : '';
    stage.style.transform = rotated ? `translateX(${innerWidth}px) rotate(90deg)` : '';
    touchLayer.hidden = !rotated;
    const style = getComputedStyle(stage);
    let width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    let height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (!controls.hidden && touchDevice) {
      if (portrait && !rotated) height -= controls.offsetHeight;
      else width -= controls.offsetWidth;
    }
    const gameWidth = canvas.width || 4;
    const gameHeight = canvas.height || 3;
    const scale = Math.max(0, Math.min(width / gameWidth, height / gameHeight));
    frame.style.width = `${Math.floor(gameWidth * scale)}px`;
    frame.style.height = `${Math.floor(gameHeight * scale)}px`;
  }

  addEventListener('resize', layout);
  addEventListener('orientationchange', layout);
  new MutationObserver(layout).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
  layout();

  // ---------------------------------------------------------------- assets
  //
  // The engine asks for one file at a time and stops until it has it. To keep
  // that from ever showing, files are downloaded before they are asked for:
  // the page reads the script that follows the text on screen, works out
  // which pictures and sounds it names, and fetches them into memory. A file
  // that is already there is handed over without suspending the engine.

  const CACHE_LIMIT = (touchDevice ? 128 : 256) * 1024 * 1024;
  const LOOKAHEAD_CHARS = 30000;            // script read past the current text
  const LOOKAHEAD_BYTES = CACHE_LIMIT * 0.4; // most to download ahead of the reader
  const PREFETCH_PARALLEL = 3;

  const manifest = new Map(); // key -> bytes to download
  const cache = new Map();    // key -> Uint8Array, least recently used first
  const inflight = new Map(); // key -> Promise<Uint8Array | null>
  const stats = { instant: 0, waited: 0, waitedMs: 0, prefetched: 0 };
  let cacheBytes = 0;
  let pending = 0;
  let busyTimer = 0;

  function setBusy(delta, text) {
    pending += delta;
    if (text) busy.textContent = text;
    clearTimeout(busyTimer);
    if (pending > 0) {
      busyTimer = setTimeout(() => { busy.hidden = false; }, text ? 0 : 500);
    } else {
      busy.hidden = true;
      busy.textContent = 'Loading…';
      pump();
    }
  }

  function remember(key, data) {
    if (cache.has(key)) return;
    cache.set(key, data);
    cacheBytes += data.length;
    for (const [oldKey, old] of cache) {
      if (cacheBytes <= CACHE_LIMIT || oldKey === key) break;
      cache.delete(oldKey);
      cacheBytes -= old.length;
    }
  }

  /**
   * Gets one file, or joins the download already under way. A dropped
   * connection is retried until it comes back rather than reported as a
   * missing file. Resolves to null if the game does not have the file.
   */
  function load(key) {
    let promise = inflight.get(key);
    if (promise) return promise;
    promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await source.read(key);
          if (data) remember(key, data);
          return data;
        } catch (err) {
          debug('read failed', key, err);
          if (pending > 0) setBusy(0, err.userMessage || 'Connection lost — retrying…');
          await sleep(Math.min(4000, 300 * 2 ** attempt));
        }
      }
    })();
    inflight.set(key, promise);
    promise.finally(() => inflight.delete(key));
    return promise;
  }

  function deliver(key, data, length, dst) {
    if (data.length > length) data = data.subarray(0, length);
    Module.HEAPU8.set(data, dst);
    noteRequest(key);
    return data.length;
  }

  /** Engine callback: the file, if it is already in memory (-2 otherwise). */
  function ponsCached(key, length, dst) {
    const data = cache.get(key);
    if (!data) return -2;
    cache.delete(key);
    cache.set(key, data);
    stats.instant++;
    return deliver(key, data, length, dst);
  }

  /** Engine callback: the file, with the engine suspended until it is here. */
  async function ponsFetch(key, length, dst) {
    const started = performance.now();
    setBusy(1);
    try {
      const data = await load(key);
      const ms = Math.round(performance.now() - started);
      stats.waited++;
      stats.waitedMs += ms;
      debug('waited', ms, 'ms for', key);
      return data ? deliver(key, data, length, dst) : -1;
    } finally {
      setBusy(-1);
    }
  }

  // ------------------------------------------------------------ look-ahead

  const soundTables = { bgm: new Map(), se: new Map(), me: new Map() };
  const aliases = new Map();
  const queue = [];     // wanted soon, nearest first
  const idleQueue = []; // worth having, fetched when nothing else is wanted
  const bootFiles = []; // what the engine asks for before the story starts
  const utf8 = new TextDecoder();
  const fontsKey = `umineko.fonts.${gameId}`;
  const bootKey = `umineko.boot.${gameId}`;
  let prefetching = 0;
  let lastCursor = 0;
  // Learnt from what the engine asks for: which of two versions of a file
  // this reader's settings select ('' while unknown).
  let spriteSet = ''; // 'big/' for the redrawn sprites, 'old' for the originals
  let language = '';  // 'en/' for pictures with English text, 'jp' for the originals

  function readManifest(bytes) {
    for (const line of utf8.decode(bytes).split('\n')) {
      const cols = line.split('\t');
      if (cols.length >= 2) manifest.set(cols[0], Number(cols[1]));
    }
  }

  /** Script path ("BMP\\Tati\\x.png", ":a;bmp\\x.bmp") -> manifest key. */
  const toKey = (value) => value.replace(/^:[^;]*;/, '').replace(/\\/g, '/').replace(/^(\.?\/)+/, '').toLowerCase();

  /**
   * The script plays music and sounds by number ("bgm1 5") and maps numbers
   * to files in long "if %n = 5 mov $file,"bgm\sea.ogg"" tables; effects name
   * their mask pictures once, up front. Both are read here.
   */
  function readScript(bytes) {
    const text = utf8.decode(bytes);
    for (const m of text.matchAll(/if\s+%(bgm|se|me)\w*\s*=\s*(\d+)\s+mov\s+\$\w+\s*,\s*"([^"\n]+)"/gi)) {
      soundTables[m[1].toLowerCase()].set(Number(m[2]), toKey(m[3]));
    }
    const masks = new Set();
    for (const m of text.matchAll(/^\s*effect\s+\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*"([^"\n]+)"/gim)) {
      masks.add(toKey(m[1]));
    }
    return [...masks].filter((key) => manifest.has(key));
  }

  function recall(storageKey, fallback) {
    try {
      return JSON.parse(localStorage.getItem(storageKey)) || fallback;
    } catch (err) {
      return fallback; // private browsing
    }
  }

  function keep(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (err) { /* not remembered */ }
  }

  /**
   * What the last session needed to get from the Start button to the first
   * line of text (title screen, menus), and the fonts: large, and wanted the
   * moment that line appears.
   */
  function startupFiles() {
    const files = [...recall(bootKey, []), ...recall(fontsKey, ['fonts/face0.otf', 'fonts/face4.ttf'])];
    return files.filter((key) => manifest.has(key));
  }

  function noteRequest(key) {
    if (key.startsWith('big/')) spriteSet = 'big/';
    else if (manifest.has(`big/${key.replace(/\.bmp$/, '.png')}`)) spriteSet = 'old';
    if (key.startsWith('en/')) language = 'en/';
    else if (manifest.has(`en/${key}`)) language = 'jp';
    if (key.startsWith('fonts/')) {
      const fonts = recall(fontsKey, []);
      if (!fonts.includes(key)) keep(fontsKey, [...fonts, key]);
    } else if (!lastCursor && bootFiles.length < 300 && !bootFiles.includes(key)) {
      bootFiles.push(key);
      keep(bootKey, bootFiles);
    }
  }

  /** Asks the engine what a name in the script currently stands for. */
  function resolve(name, variable) {
    if (!variable && aliases.has(name)) return aliases.get(name);
    if (name.length > 200) return null;
    const buffer = Module._web_name_buffer();
    for (let i = 0; i < name.length; i++) Module.HEAPU8[buffer + i] = name.charCodeAt(i);
    Module.HEAPU8[buffer + name.length] = 0;
    const address = Module._web_resolve(variable ? 1 : 0);
    const value = address ? Module.UTF8ToString(address) : null;
    if (!variable) aliases.set(name, value);
    return value;
  }

  /** Of two versions of a file, the one the reader's settings select; both while that is unknown. */
  const choose = (learnt, prefix, special, plain) => (
    !special || !plain ? [special || plain].filter(Boolean)
      : learnt === prefix ? [special] : learnt ? [plain] : [special, plain]);

  /** The files a script value can turn into, given how the script loads pictures. */
  function filesFor(value) {
    const key = toKey(value);
    if (!key || /\.(mpe?g|avi)$/.test(key)) return []; // movies are streamed by the page
    const have = (k) => (manifest.has(k) ? k : null);
    if (manifest.has(key)) return choose(language, 'en/', have(`en/${key}`), key);
    // Sprites are named without their extension and exist in two art styles.
    const old = have(`${key}.png`) || have(`${key}.bmp`);
    return choose(spriteSet, 'big/', have(`big/${key}.png`), old);
  }

  /** Lists, in order, the files named by the script after the text on screen. */
  function upcomingFiles(cursor) {
    const end = Math.min(Module._web_script_end(), cursor + LOOKAHEAD_CHARS);
    const lines = utf8.decode(Module.HEAPU8.subarray(cursor, end)).split('\n');
    lines.shift(); // the text being read
    lines.pop();   // cut mid-line
    const found = new Set();
    for (const raw of lines) {
      const line = raw.replace(/;[^"]*$/, '').trim().toLowerCase();
      if (!line || line.startsWith('lang') || !/^[a-z_*~]/.test(line)) continue; // text
      if (/^(return|end|reset)\b/.test(line)) break; // the story continues somewhere else
      for (const m of line.matchAll(/\b(bgm|se|me)(play2?|\dv?)\s+(\d+)(?:\s*,\s*(\d+))?/g)) {
        const number = m[2].startsWith('play') && m[1] !== 'bgm' ? m[4] : m[3];
        const key = soundTables[m[1]].get(Number(number));
        if (key && manifest.has(key)) found.add(key);
      }
      for (const m of line.matchAll(/"([^"]*)"|(\$?)([a-z_][a-z0-9_]*)/g)) {
        const value = m[1] !== undefined ? m[1] : resolve(m[3], m[2] === '$');
        if (value) for (const key of filesFor(value)) found.add(key);
      }
    }
    return found;
  }

  function pump() {
    // The file the engine is stopped on gets the whole connection.
    while (pending === 0 && prefetching < PREFETCH_PARALLEL && (queue.length || idleQueue.length)) {
      const key = queue.length ? queue.shift() : idleQueue.shift();
      if (cache.has(key) || inflight.has(key)) continue;
      prefetching++;
      stats.prefetched++;
      debug('prefetch', key);
      load(key).finally(() => {
        prefetching--;
        pump();
      });
    }
  }

  /** Queues files for download, nearest first, replacing what was queued. */
  function prefetch(keys) {
    queue.length = 0;
    let bytes = 0;
    for (const key of keys) {
      bytes += manifest.get(key) || 0;
      if (bytes > LOOKAHEAD_BYTES) break;
      if (cache.has(key)) {
        // About to be used: keep it clear of eviction.
        const data = cache.get(key);
        cache.delete(key);
        cache.set(key, data);
      } else queue.push(key);
    }
    pump();
  }

  function lookAhead() {
    const cursor = Module._web_text_cursor();
    if (!cursor || cursor === lastCursor) return;
    lastCursor = cursor;
    prefetch(upcomingFiles(cursor));
  }

  // ---------------------------------------------------------------- movies

  function ponsPlayVideo(key, skippable) {
    const name = key.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    debug('video', key, skippable);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.hidden = true;
        video.onended = video.onerror = video.onclick = null;
        removeEventListener('keyup', onKey, true);
        resolve();
      };
      const onKey = (event) => {
        if (skippable && ['Enter', ' ', 'Escape'].includes(event.key)) finish();
      };
      video.onended = finish;
      video.onerror = finish;
      video.onclick = () => { if (skippable) finish(); };
      addEventListener('keyup', onKey, true);
      const url = source.movieUrl(name);
      if (!url) return finish();
      video.muted = false;
      video.src = url;
      video.hidden = false;
      video.play().catch(() => {
        // Sound was refused without a fresh tap: play silently instead.
        video.muted = true;
        video.play().catch(finish);
      });
    });
  }

  // ----------------------------------------------------------------- sound
  //
  // The engine's sound comes out of one Web Audio node that asks it for the
  // next buffer. Phones cut that off whenever the page is left (lock screen,
  // another app), and may hand back a context that claims to run while its
  // node is never called again. Whether sound is alive is therefore judged
  // by the buffers actually being requested, and it is revived a step
  // further on each touch until it is: resume, new node, new context.

  // The engine mixes at the rate of the browser's audio context, and resamples
  // music of any other rate badly (audible crackle). Nearly all of the game's
  // music is 44.1 kHz, so the context is created at that rate and the browser
  // does the conversion to whatever the device plays.
  const MUSIC_RATE = 44100;

  let lastBuffer = 0;    // when the engine was last asked for sound
  let soundStale = false; // the page has been away since the context was made
  let lastRevival = 0;
  let revivalStep = 0;
  let outputChannels = 2;

  const sdl = () => (Module && Module.SDL2 && Module.SDL2.audio && Module.SDL2.audioContext ? Module.SDL2 : null);
  const soundFlowing = () => performance.now() - lastBuffer < 1000;

  /** Notes every buffer request made to the engine. */
  function watchSound(node) {
    if (!node || node.ponsWatched) return;
    const feed = node.onaudioprocess;
    node.onaudioprocess = (event) => {
      lastBuffer = performance.now();
      outputChannels = event.outputBuffer.numberOfChannels;
      feed(event);
    };
    node.ponsWatched = true;
  }

  function replaceSoundNode(context) {
    const SDL2 = sdl();
    const old = SDL2.audio.scriptProcessorNode;
    const node = context.createScriptProcessor(old.bufferSize, 0, outputChannels);
    node.onaudioprocess = old.onaudioprocess;
    node.ponsWatched = true;
    old.onaudioprocess = null;
    try {
      old.disconnect();
    } catch (err) { /* already gone with its context */ }
    node.connect(context.destination);
    SDL2.audio.scriptProcessorNode = node;
  }

  function newSoundContext(sampleRate) {
    const Context = window.AudioContext || window.webkitAudioContext;
    try {
      return new Context({ sampleRate });
    } catch (err) {
      return new Context(); // wrong pitch beats no sound
    }
  }

  function replaceSoundContext() {
    const SDL2 = sdl();
    const old = SDL2.audioContext;
    const context = newSoundContext(old.sampleRate); // the engine keeps mixing for this rate
    SDL2.audioContext = context;
    replaceSoundNode(context);
    old.close().catch(() => {});
  }

  /** On every touch: if no sound is being produced, try the next way to get it back. */
  function wakeSound() {
    const SDL2 = sdl();
    if (!SDL2 || document.hidden) return;
    if (!SDL2.audio.scriptProcessorNode.ponsWatched) {
      // Nothing is known about this node yet: watch it before judging it.
      watchSound(SDL2.audio.scriptProcessorNode);
      SDL2.audioContext.resume().catch(() => {});
      return;
    }
    const now = performance.now();
    if (soundStale) {
      // A context that has been through the lock screen cannot be trusted,
      // even when it reports that it runs and keeps asking for buffers.
      // Start over the way the Start button did: a new one, made on a touch.
      soundStale = false;
      lastRevival = now;
      revivalStep = 0;
      replaceSoundContext();
      debug('sound: new context after absence');
      return;
    }
    if (soundFlowing()) {
      revivalStep = 0;
      return;
    }
    if (now - lastRevival > 700) { // the events of one tap count as one attempt
      lastRevival = now;
      if (revivalStep >= 2 || SDL2.audioContext.state === 'closed') replaceSoundContext();
      else if (revivalStep === 1 || SDL2.audioContext.state === 'running') replaceSoundNode(SDL2.audioContext);
      revivalStep++;
      debug('sound revival step', revivalStep, SDL2.audioContext.state);
    }
    SDL2.audioContext.resume().catch(() => {});
  }

  // A hidden page is no longer run often enough to feed the sound card, which
  // then repeats its last buffer as a loud buzz: silence it while away.
  function restSound() {
    const SDL2 = sdl();
    if (!SDL2) return;
    if (document.hidden) {
      soundStale = touchDevice;
      SDL2.audioContext.suspend().catch(() => {});
    } else SDL2.audioContext.resume().catch(() => {}); // enough on desktop; phones wait for a touch
  }

  document.addEventListener('visibilitychange', restSound);
  addEventListener('pageshow', restSound);
  for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) addEventListener(type, wakeSound, true);

  if (params.has('debug')) {
    // On-screen, because a phone has no console to look at.
    const readout = document.createElement('div');
    readout.style.cssText = 'position:fixed;left:4px;top:4px;z-index:20;font:11px ui-monospace,monospace;color:#8f8;background:rgba(0,0,0,.6);padding:2px 5px;pointer-events:none';
    document.body.append(readout);
    setInterval(() => {
      const SDL2 = sdl();
      readout.textContent = SDL2
        ? `sound: ${SDL2.audioContext.state} ${SDL2.audioContext.sampleRate} Hz${soundStale ? ' stale' : ''} · last buffer ${lastBuffer ? Math.round(performance.now() - lastBuffer) : '—'} ms ago · revival step ${revivalStep}`
        : 'sound: not open';
    }, 500);
  }

  // ----------------------------------------------------------------- saves

  const uploaded = new Map();
  let syncing = false;

  function listLocalSaves(dir, prefix, out) {
    const FS = Module.FS;
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const full = `${dir}/${name}`;
      const stat = FS.stat(full);
      if (FS.isDir(stat.mode)) {
        if (!prefix) listLocalSaves(full, `${name}/`, out);
      } else {
        out.push({ name: prefix + name, full, stamp: `${stat.size}:${+new Date(stat.mtime)}` });
      }
    }
    return out;
  }

  /** Sends every save file the engine has written since the last pass. */
  async function syncSaves() {
    if (syncing || !Module) return;
    syncing = true;
    try {
      for (const file of listLocalSaves(SAVE_DIR, '', [])) {
        if (uploaded.get(file.name) === file.stamp) continue;
        await source.writeSave(file.name, Module.FS.readFile(file.full));
        uploaded.set(file.name, file.stamp);
      }
    } catch (err) {
      // Offline: the files stay marked as changed and go out on a later pass.
      debug('save not kept yet', err);
    } finally {
      syncing = false;
    }
  }

  // ----------------------------------------------------------------- input

  const SDLK = { a: 97, s: 115 };
  const SDL_BUTTON_RIGHT = 3;

  function toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const request = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!request) return;
      Promise.resolve(request.call(root)).then(() => {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      }).catch(() => {});
    }
  }

  const actions = {
    menu() {
      Module._web_push_button(SDL_BUTTON_RIGHT, 1);
      Module._web_push_button(SDL_BUTTON_RIGHT, 0);
    },
    log() { Module._web_push_wheel(1); },
    auto() { tapKey(SDLK.a); },
    skip() { tapKey(SDLK.s); },
    fullscreen: toggleFullscreen,
    turn() {
      turned = !turned;
      try {
        localStorage.setItem('umineko.turned', turned ? '1' : '0');
      } catch (err) { /* not remembered */ }
      layout();
    },
  };

  function tapKey(sym) {
    Module._web_push_key(sym, 1);
    Module._web_push_key(sym, 0);
  }

  controls.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button && Module) actions[button.dataset.action]();
  });

  // The engine's own fullscreen toggle resizes the canvas behind the page's
  // back, so "f" is handled here instead.
  for (const type of ['keydown', 'keyup']) {
    addEventListener(type, (event) => {
      if (event.key !== 'f' && event.key !== 'F') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (type === 'keyup') toggleFullscreen();
    }, true);
  }

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  // Two fingers anywhere on the picture open the game's menu.
  canvas.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2 && Module) actions.menu();
  }, { passive: true });

  // With the stage turned, the browser's coordinates are a quarter turn away
  // from the game's, so touches are translated here and handed to the engine.
  const SDL_BUTTON_LEFT = 1;
  let pressedAt = null;

  function gamePoint(touch) {
    const box = frame.getBoundingClientRect();
    const along = (value) => Math.min(1, Math.max(0, value));
    return [
      Math.round(along((touch.clientY - box.top) / box.height) * (canvas.width - 1)),
      Math.round(along(1 - (touch.clientX - box.left) / box.width) * (canvas.height - 1)),
    ];
  }

  function onTurnedTouch(event) {
    event.preventDefault();
    if (!Module) return;
    if (event.type === 'touchstart' && event.touches.length === 2) return actions.menu();
    const touch = event.touches[0];
    if (touch) {
      const [x, y] = gamePoint(touch);
      Module._web_push_pointer(x, y, 0, 0);
      if (!pressedAt) Module._web_push_pointer(x, y, SDL_BUTTON_LEFT, 1);
      pressedAt = [x, y];
    } else if (pressedAt) {
      Module._web_push_pointer(pressedAt[0], pressedAt[1], SDL_BUTTON_LEFT, 0);
      pressedAt = null;
    }
  }

  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    touchLayer.addEventListener(type, onTurnedTouch, { passive: false });
  }

  // iPhones cannot put a page in full screen: do not offer it there.
  if (!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen) {
    controls.querySelector('[data-action="fullscreen"]').hidden = true;
  }

  // ------------------------------------------------------------------ boot

  async function loadEverything() {
    bootStatus.textContent = 'Loading game script and saves…';
    const data = await source.open(gameId);
    $('boot-title').textContent = data.title;
    document.title = data.title;
    readManifest(data.manifest);
    // Start on what every session needs while the reader looks at the Start button.
    idleQueue.push(...readScript(data.script));
    prefetch(startupFiles());
    return data;
  }

  async function start() {
    startButton.disabled = true;
    bootStatus.textContent = 'Starting…';
    const data = await preload;

    Module = await createPonscripter({
      canvas,
      SDL2: { audioContext: newSoundContext(MUSIC_RATE) },
      locateFile: (file) => `engine/${file}`,
      print: (text) => console.log(text),
      printErr: (text) => console.warn(text),
      ponsCached,
      ponsFetch,
      ponsPlayVideo,
      onAbort: (reason) => fail(`The engine stopped: ${reason}`),
      onExit: () => { location.href = './'; },
    });

    if (params.has('debug')) window.ponscripter = { Module, ponsPlayVideo, actions, stats, cache, soundFlowing };

    const FS = Module.FS;
    FS.mkdirTree(SAVE_DIR);
    FS.writeFile(`${GAME_DIR}/manifest.tsv`, data.manifest);
    FS.writeFile(`${GAME_DIR}/${data.scriptName}`, data.script);
    for (const save of data.saves) {
      const full = `${SAVE_DIR}/${save.name}`;
      FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      FS.writeFile(full, save.bytes);
      FS.utime(full, save.mtime, save.mtime);
    }
    for (const file of listLocalSaves(SAVE_DIR, '', [])) uploaded.set(file.name, file.stamp);
    preload = null;
    FS.chdir(GAME_DIR);

    boot.hidden = true;
    controls.hidden = false;
    layout();
    canvas.focus();

    setInterval(syncSaves, 250);
    if (!params.has('nolookahead')) setInterval(lookAhead, 200);
    setInterval(() => { if (sdl()) watchSound(sdl().audio.scriptProcessorNode); }, 1000);
    addEventListener('pagehide', syncSaves);
    document.addEventListener('visibilitychange', () => { if (document.hidden) syncSaves(); });
    if (navigator.wakeLock) {
      const keepAwake = () => navigator.wakeLock.request('screen').catch(() => {});
      keepAwake();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
    }

    Module.callMain(['--save', 'saves']);
  }

  // A WebAssembly trap stops the engine for good; say so instead of leaving
  // a frozen picture, and keep the stack for a bug report.
  function onUncaught(error) {
    if (error && error.name === 'ExitStatus') return;
    console.error(error);
    const text = error && error.stack ? error.stack : String(error && error.message ? error.message : error);
    if (!boot.hidden) return fail(text);
    if (error instanceof WebAssembly.RuntimeError) {
      syncSaves();
      $('boot-title').textContent = 'The game stopped';
      fail(`${text}\n\nReload the page to continue from your last save.`);
    }
  }
  addEventListener('error', (event) => onUncaught(event.error || event.message));
  addEventListener('unhandledrejection', (event) => onUncaught(event.reason));

  startButton.addEventListener('click', () => start().catch(fail));
  preload = loadEverything();
  preload.then(() => {
    bootStatus.textContent = 'Ready.';
    startButton.disabled = false;
  }, fail);
})();
