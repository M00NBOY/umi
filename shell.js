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
  const reader = $('reader');
  const readerPage = $('reader-page'); // the text itself, inside the scrolling reader
  const readerButtons = $('reader-buttons'); // what can be pressed, under the text
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
  let textBelow = false; // the text is shown under the picture, not on it
  const waitIcons = {}; // 1, 2 -> the game's click-wait icons, from the script
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
    touchLayer.hidden = !touchDevice;
    // Read sideways, the buttons stay out of the way until asked for.
    const autoHide = touchDevice && !(portrait && !rotated);
    document.body.classList.toggle('autohide', autoHide);
    if (!autoHide) showControls(false);
    const style = getComputedStyle(stage);
    let width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    let height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (!controls.hidden && touchDevice && !autoHide) {
      if (portrait && !rotated) height -= controls.offsetHeight;
      else width -= controls.offsetWidth;
    }
    if (portrait && !rotated) height *= 0.6; // the rest for the text in large print
    textBelow = portrait && !rotated;
    if (Module) {
      Module._web_set_text_off_picture(textBelow ? 1 : 0,
        waitIcons[1] ? waitIcons[1].sprite : -1, waitIcons[2] ? waitIcons[2].sprite : -1);
    }
    const gameWidth = canvas.width || 4;
    const gameHeight = canvas.height || 3;
    const scale = Math.max(0, Math.min(width / gameWidth, height / gameHeight));
    frame.style.width = `${Math.floor(gameWidth * scale)}px`;
    frame.style.height = `${Math.floor(gameHeight * scale)}px`;
  }

  // Sideways, a tap beside the picture shows the buttons for a few seconds.
  const CONTROLS_SHOWN_MS = 5000;
  let controlsTimer = 0;

  function showControls(on) {
    clearTimeout(controlsTimer);
    document.body.classList.toggle('controls-shown', on);
    if (on) controlsTimer = setTimeout(() => showControls(false), CONTROLS_SHOWN_MS);
  }

  stage.addEventListener('click', (event) => {
    if (!document.body.classList.contains('autohide')) return;
    if (controls.contains(event.target)) showControls(true); // in use: keep them
    else if (!frame.contains(event.target)) showControls(!document.body.classList.contains('controls-shown'));
  });

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
    // The icons the game shows while it waits for a click (1) or to turn the
    // page (2): sprites, set up as lsph TextCC1SpNum,":bl/3,160,2;bmp\cursor0.png".
    const spriteNumbers = new Map();
    for (const m of text.matchAll(/^\s*numalias\s+TextCC([12])SpNum\s*,\s*(\d+)/gim)) spriteNumbers.set(m[1], Number(m[2]));
    for (const m of text.matchAll(/\blsph?\s+TextCC([12])SpNum\s*,\s*"([^"\n]+)"/gi)) {
      if (waitIcons[m[1]] || !spriteNumbers.has(m[1])) continue;
      const tag = /^:([^/;]*)(?:\/(\d+),(\d+),(\d+))?;(.+)$/.exec(m[2]);
      if (!tag) continue;
      waitIcons[m[1]] = {
        sprite: spriteNumbers.get(m[1]),
        key: toKey(tag[5]),
        cells: Number(tag[2] || 1),
        ms: Number(tag[3] || 0),
        loop: Number(tag[4] || 0), // 0 round, 1 once, 2 back and forth, 3 still
      };
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

  const videoHint = $('video-hint');

  // A tap anywhere but on the movie gives it its sound, which a phone only
  // allows in answer to a touch.
  function soundForMovie(event) {
    if (!moviePlaying || !video.muted || event.target === video) return;
    video.muted = false;
    video.play().catch(() => { video.muted = true; });
    videoHint.hidden = true;
  }
  addEventListener('touchend', soundForMovie, true);
  addEventListener('click', soundForMovie, true);

  /**
   * Phones let a media element play with sound once it has been played in
   * answer to a touch: done for the movie element on the Start button, so
   * that the game's movies, started by the engine, keep their sound.
   */
  function unlockMovieSound() {
    try {
      video.load();
      const playing = video.play();
      if (playing) playing.then(() => video.pause(), () => {});
    } catch (err) { /* nothing to unlock */ }
  }

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
        videoHint.hidden = true;
        removeEventListener('keyup', onKey, true);
        moviePlaying = false;
        updateReaderShown();
        resolve();
      };
      const onKey = (event) => {
        if (skippable && ['Enter', ' ', 'Escape'].includes(event.key)) finish();
      };
      video.onended = finish;
      video.onerror = finish;
      video.onclick = () => { if (skippable) finish(); };
      addEventListener('keyup', onKey, true);
      Promise.resolve(source.movieUrl(name)).then((url) => {
        if (!url) return finish(); // no version of it this browser can play
        moviePlaying = true;
        updateReaderShown();
        video.muted = false;
        video.src = url;
        video.hidden = false;
        video.play().catch(() => {
          // Sound was refused without a fresh tap: play silently instead,
          // until a tap beside the picture (one on it skips the movie).
          video.muted = true;
          video.play().then(() => { videoHint.hidden = false; }, finish);
        });
      }, finish);
    });
  }

  // ----------------------------------------------------------- large print
  //
  // Held upright, a phone shows the picture too small to read its text, so
  // the text is shown again under it, in the game's own fonts and colours.
  // The engine reports each glyph as it draws it (web_platform.h); a page it
  // redraws from its buffer (after the menu, in the backlog) has lost its
  // colours there, so pages already seen are put back as they were shown.

  const fontFamilies = new Map(); // style -> CSS family of the face it is drawn with
  const loadedFonts = new Set();
  const pagesSeen = new Map(); // text without spaces -> HTML, most recent last
  let run = null;       // { node, key } the text node being written to
  let restoring = null; // the page the engine is redrawing, collected aside
  let stickToEnd = true;

  function fontFamily(style) {
    let family = fontFamilies.get(style);
    if (family !== undefined) return family;
    const address = Module._web_font_file(style);
    const key = address ? toKey(Module.UTF8ToString(address)) : '';
    family = key ? `pons-${key.replace(/[^a-z0-9]/g, '-')}` : '';
    fontFamilies.set(style, family);
    if (family && !loadedFonts.has(family) && window.FontFace) {
      loadedFonts.add(family);
      load(key).then((bytes) => {
        if (!bytes) return;
        const face = new FontFace(family, bytes);
        document.fonts.add(face);
        return face.load();
      }).catch((err) => debug('font', key, err));
    }
    return family;
  }

  const readerText = (node) => node.textContent.replace(/\s+/g, '');

  // ------- the icon that says the game waits for a click, as in the game

  let waitIcon = null;
  let waitTimer = 0;
  let waitingFor = 0; // the kind of click the game waits for, 0 if none
  const iconUrls = new Map(); // key -> Promise<object URL>

  function iconUrl(key) {
    let url = iconUrls.get(key);
    if (!url) {
      url = load(key).then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) : null));
      iconUrls.set(key, url);
    }
    return url;
  }

  function hideWaitIcon() {
    clearInterval(waitTimer);
    if (waitIcon) waitIcon.remove();
    waitIcon = null;
  }

  function showWaitIcon(kind) {
    hideWaitIcon();
    const icon = waitIcons[kind];
    if (!icon) return;
    const span = document.createElement('span');
    span.className = 'wait-icon';
    span.style.backgroundSize = `${icon.cells * 100}% 100%`;
    waitIcon = span;
    readerPage.append(span);
    scrollReader();
    iconUrl(icon.key).then((url) => {
      if (url && waitIcon === span) span.style.backgroundImage = `url(${url})`;
    });
    if (icon.cells < 2 || !icon.ms || icon.loop === 3) return;
    // Cells side by side, shown in turn the way the engine animates sprites.
    let cell = 0;
    let step = 1;
    waitTimer = setInterval(() => {
      if (cell + step >= icon.cells || cell + step < 0) {
        if (icon.loop === 1) return clearInterval(waitTimer);
        if (icon.loop === 2) step = -step;
        else cell = -1;
      }
      cell += step;
      span.style.backgroundPosition = `${(cell / (icon.cells - 1)) * 100}% 0`;
    }, icon.ms);
  }

  function rememberPage() {
    hideWaitIcon();
    const text = readerText(readerPage);
    if (!text) return;
    pagesSeen.delete(text);
    pagesSeen.set(text, readerPage.innerHTML);
    if (pagesSeen.size > 200) pagesSeen.delete(pagesSeen.keys().next().value);
  }

  function scrollReader() {
    if (stickToEnd && !restoring) reader.scrollTop = reader.scrollHeight;
  }

  function ponsTextGlyph(unicode, rgb, style, scale) {
    if (!restoring) {
      leaveLog();
      waitingFor = 0;
      hideWaitIcon();
    }
    const target = restoring || readerPage;
    const key = `${rgb}/${style}/${scale}`;
    const char = String.fromCharCode(unicode);
    if (run && run.key === key && run.node.parentNode && run.node.parentNode.parentNode === target) {
      run.node.appendData(char);
    } else {
      const span = document.createElement('span');
      span.style.color = `#${rgb.toString(16).padStart(6, '0')}`;
      const family = fontFamily(style);
      if (family) span.style.fontFamily = `"${family}", serif`;
      if (scale !== 1) span.style.fontSize = `${scale}em`;
      const node = document.createTextNode(char);
      span.append(node);
      target.append(span);
      run = { node, key };
    }
    scrollReader();
  }

  const TEXT_CLEAR = 0;
  const TEXT_NEWLINE = 1;
  const TEXT_RESTORE_BEGIN = 2;
  const TEXT_RESTORE_END = 3;
  const TEXT_CLICK_WAIT = 4;
  const TEXT_PAGE_WAIT = 5;
  const TEXT_GO = 6;
  const TEXT_LOG_BEGIN = 7;
  const TEXT_LOG_END = 8;
  const TEXT_ON = 9;
  const TEXT_WINDOW_SHOWN = 10;
  const TEXT_WINDOW_HIDDEN = 11;

  // The text goes when the game takes its text window off the picture (a
  // scene change, a movie), and comes back with it, as on the picture.
  let textWindowShown = true;
  let moviePlaying = false;

  function updateReaderShown() {
    const shown = (textWindowShown || pageBeforeLog !== null) && !moviePlaying;
    reader.classList.toggle('away', !shown);
  }

  // The backlog: the game shows one past page at a time, as a sprite. It is
  // shown here instead of the page being read, which comes back after.
  let pageBeforeLog = null; // HTML of the page being read, while in the backlog

  function leaveLog() {
    if (pageBeforeLog === null) return;
    readerPage.innerHTML = pageBeforeLog;
    pageBeforeLog = null;
    reader.classList.remove('log');
    updateReaderShown();
    stickToEnd = true;
    if (waitingFor) showWaitIcon(waitingFor);
    scrollReader();
  }

  function ponsTextEvent(event) {
    if (event === TEXT_LOG_BEGIN) {
      if (pageBeforeLog === null) {
        hideWaitIcon();
        pageBeforeLog = readerPage.innerHTML;
      }
      restoring = document.createElement('div');
    } else if (event === TEXT_LOG_END && restoring) {
      // The game keeps its backlog without colours, and shows it in one
      // (pale yellow): a page seen here gets back its line breaks and its
      // red and blue, the rest in the backlog's colour.
      const seen = pagesSeen.get(readerText(restoring));
      const first = restoring.querySelector('span');
      if (seen !== undefined && first) {
        const page = document.createElement('div');
        page.innerHTML = seen;
        for (const span of page.querySelectorAll('span')) {
          if (span.style.color === 'rgb(255, 255, 255)') span.style.color = first.style.color;
        }
        readerPage.replaceChildren(...page.childNodes);
      } else readerPage.replaceChildren(...restoring.childNodes);
      restoring = null;
      reader.classList.add('log');
      updateReaderShown();
      reader.scrollTop = 0;
      stickToEnd = false;
    } else if (event === TEXT_WINDOW_SHOWN || event === TEXT_WINDOW_HIDDEN) {
      textWindowShown = event === TEXT_WINDOW_SHOWN;
      updateReaderShown();
      return;
    } else if (event === TEXT_ON) {
      leaveLog();
    } else if (event === TEXT_CLEAR) {
      if (restoring) return;
      leaveLog();
      waitingFor = 0;
      rememberPage();
      readerPage.replaceChildren();
      fontFamilies.clear(); // the script may have mapped other fonts since
      stickToEnd = true;
    } else if (event === TEXT_CLICK_WAIT || event === TEXT_PAGE_WAIT) {
      waitingFor = event === TEXT_CLICK_WAIT ? 1 : 2;
      if (!restoring) showWaitIcon(waitingFor);
      return;
    } else if (event === TEXT_GO) {
      waitingFor = 0;
      hideWaitIcon();
    } else if (event === TEXT_NEWLINE) {
      if (!restoring) {
        waitingFor = 0;
        hideWaitIcon();
      }
      (restoring || readerPage).append('\n');
      scrollReader();
    } else if (event === TEXT_RESTORE_BEGIN) {
      rememberPage();
      restoring = document.createElement('div');
    } else if (event === TEXT_RESTORE_END && restoring) {
      const seen = pagesSeen.get(readerText(restoring));
      if (seen !== undefined) readerPage.innerHTML = seen;
      else readerPage.replaceChildren(...restoring.childNodes);
      restoring = null;
      stickToEnd = true;
      if (waitingFor) showWaitIcon(waitingFor); // still waiting, as before the redraw
      scrollReader();
    }
    run = null;
  }

  reader.addEventListener('scroll', () => {
    stickToEnd = reader.scrollTop + reader.clientHeight >= reader.scrollHeight - 8;
  }, { passive: true });

  // A swipe down on the text goes back a page (opening the backlog), a swipe
  // up forward again (closing it after the last), as the mouse wheel does.
  // A long page scrolls first.
  let swipeFrom = null;
  reader.addEventListener('touchstart', (event) => {
    const t = event.touches[0];
    swipeFrom = event.touches.length === 1 ? { x: t.clientX, y: t.clientY, top: reader.scrollTop } : null;
  }, { passive: true });
  reader.addEventListener('touchend', (event) => {
    const t = event.changedTouches[0];
    if (!swipeFrom || !t || !Module) return;
    const dx = t.clientX - swipeFrom.x;
    const dy = t.clientY - swipeFrom.y;
    const atTop = swipeFrom.top <= 0;
    const atEnd = swipeFrom.top + reader.clientHeight >= reader.scrollHeight - 2;
    swipeFrom = null;
    if (Math.abs(dy) < 40 || Math.abs(dy) < 1.5 * Math.abs(dx)) return;
    if (dy > 0 && atTop) Module._web_push_wheel(1);
    else if (dy < 0 && atEnd) Module._web_push_wheel(-1);
  }, { passive: true });

  // ------------------------------------------------------------- buttons
  //
  // Upright, what the game lets the reader press is shown again under the
  // text, larger: choices made of text (select) as text, in the game's font
  // and colours (and only there: the engine leaves them off the picture);
  // buttons drawn as pictures (menus, the backlog's arrows) as a copy of that
  // part of the picture, kept up to date so the pointer's highlight shows.

  let buttonsKey = '';
  let crops = []; // [{ canvas, b }] picture buttons, to repaint
  let choicesOffPicture = false; // the game waits on a choice the picture does not show

  function pressGameButton(b) {
    const x = Math.round(b.x + b.w / 2);
    const y = Math.round(b.y + b.h / 2);
    Module._web_push_pointer(x, y, 0, 0); // the engine takes the button under the pointer
    setTimeout(() => {
      Module._web_push_pointer(x, y, SDL_BUTTON_LEFT, 1);
      Module._web_push_pointer(x, y, SDL_BUTTON_LEFT, 0);
    }, 60);
  }

  function paintCrop(canvasEl, b) {
    const pixels = Module._web_screen_pixels();
    const pitch = Module._web_screen_pitch();
    if (!pixels || !pitch) return;
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    const w = Math.min(b.w, canvas.width - x);
    const h = Math.min(b.h, canvas.height - y);
    if (w <= 0 || h <= 0) return;
    const image = new ImageData(w, h);
    const out = image.data;
    const heap = Module.HEAPU8;
    for (let row = 0; row < h; row++) {
      let src = pixels + (y + row) * pitch + x * 4;
      let dst = row * w * 4;
      for (let col = 0; col < w; col++, src += 4, dst += 4) {
        out[dst] = heap[src + 2];
        out[dst + 1] = heap[src + 1];
        out[dst + 2] = heap[src];
        out[dst + 3] = 255;
      }
    }
    canvasEl.getContext('2d').putImageData(image, 0, 0);
  }

  function showButtons() {
    if (!Module || !textBelow) {
      if (buttonsKey) {
        readerButtons.replaceChildren();
        buttonsKey = '';
        crops = [];
      }
      choicesOffPicture = false;
      return;
    }
    let state;
    try {
      state = JSON.parse(Module.UTF8ToString(Module._web_buttons()));
    } catch (err) {
      return;
    }
    // In the backlog, swipes and a tap do what its arrows do.
    const list = state.wait && pageBeforeLog === null ? state.buttons : [];
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    choicesOffPicture = list.some((b) => b.choice);
    const key = JSON.stringify(list);
    if (key !== buttonsKey) {
      buttonsKey = key;
      crops = [];
      readerButtons.replaceChildren(...list.map((b) => {
        const button = document.createElement('button');
        button.type = 'button';
        if (b.text !== undefined) {
          button.className = 'choice';
          // Columns the game lines up with spaces (a chapter and its date)
          // stay apart, each on its side.
          const parts = b.text.trim().split(/ {3,}|\u3000{2,}/);
          for (const part of parts) {
            const span = document.createElement('span');
            span.textContent = part;
            button.append(span);
          }
          button.style.setProperty('--off', `#${b.off.toString(16).padStart(6, '0')}`);
          button.style.setProperty('--on', `#${b.on.toString(16).padStart(6, '0')}`);
          const family = fontFamily(b.style);
          if (family) button.style.fontFamily = `"${family}", serif`;
        } else {
          button.className = 'picture';
          const crop = document.createElement('canvas');
          crop.width = Math.max(1, Math.min(b.w, canvas.width));
          crop.height = Math.max(1, Math.min(b.h, canvas.height));
          button.append(crop);
          crops.push({ canvas: crop, b });
        }
        button.addEventListener('click', (event) => {
          event.stopPropagation(); // not a tap that reads on
          pressGameButton(b);
        });
        return button;
      }));
      if (list.length) {
        // The first of them in view, below what is left of the text.
        const top = readerButtons.getBoundingClientRect().top - reader.getBoundingClientRect().top + reader.scrollTop;
        if (top + readerButtons.offsetHeight > reader.scrollTop + reader.clientHeight) {
          reader.scrollTop = Math.max(0, top - reader.clientHeight * 0.35);
        }
        stickToEnd = false;
      }
    }
    for (const { canvas: crop, b } of crops) paintCrop(crop, b);
  }

  // A tap on the text reads on, like a tap on the picture.
  reader.addEventListener('click', () => {
    // While buttons are offered, only they answer (the backlog closes on a tap).
    if (readerButtons.childElementCount && pageBeforeLog === null) return;
    if (Module) tapKey(SDLK.enter);
  });

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

  // When the page stops being run (the app left, the phone locked), the
  // sound card plays the engine's last buffer over and over, a beep, until
  // the page hears it is hidden, which comes too late on a phone. So the
  // sound goes through a volume that, with each buffer the engine fills, is
  // set to drop just after that buffer would have finished: the audio thread
  // itself silences a buffer that never comes, before it can be repeated.
  let soundGuard = null; // GainNode between the engine's node and the speakers

  function guardSound(node, context) {
    const guard = context.createGain();
    try {
      node.disconnect();
    } catch (err) { /* not connected yet */ }
    node.connect(guard);
    guard.connect(context.destination);
    soundGuard = guard;
  }

  function holdGuardOpen(seconds) {
    const guard = soundGuard;
    if (!guard || soundAway) return;
    const now = guard.context.currentTime;
    const gain = guard.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(1, now);
    // Room for the double buffering and a late call, then a short fade.
    gain.setValueAtTime(1, now + 3 * seconds);
    gain.linearRampToValueAtTime(0, now + 3 * seconds + 0.02);
  }

  /** Notes every buffer request made to the engine. */
  function watchSound(node) {
    if (!node || node.ponsWatched) return;
    const feed = node.onaudioprocess;
    node.onaudioprocess = (event) => {
      lastBuffer = performance.now();
      outputChannels = event.outputBuffer.numberOfChannels;
      feed(event);
      holdGuardOpen(event.outputBuffer.duration);
    };
    node.ponsWatched = true;
    guardSound(node, node.context);
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
    guardSound(node, context);
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
  // then repeats what it was last given as a loud buzz or beep: silence it
  // while away. On a phone the sound is played by another process, from a
  // small reserve the page fills, and the page can be frozen at any moment
  // once hidden: stopping the sound there and then would leave the last
  // music in that reserve, to be repeated. So the volume drops first, the
  // reserve fills with silence, and only then does the sound stop.
  let soundAway = false;
  let restTimer = 0;

  function restSound(event) {
    const SDL2 = sdl();
    if (!SDL2) return;
    clearTimeout(restTimer);
    const type = event ? event.type : '';
    const hidden = document.hidden || type === 'pagehide';
    if (hidden || type === 'blur') {
      soundAway = true;
      if (hidden) soundStale = touchDevice;
      if (soundGuard) {
        const now = soundGuard.context.currentTime;
        soundGuard.gain.cancelScheduledValues(now);
        soundGuard.gain.setValueAtTime(0, now);
      }
      restTimer = setTimeout(() => SDL2.audioContext.suspend().catch(() => {}), 400);
    } else {
      soundAway = false;
      SDL2.audioContext.resume().catch(() => {}); // enough on desktop; phones wait for a touch
    }
  }

  // iOS treats a page's sound as "ambient" and, in a Home Screen app, cuts it
  // off at once when the app is left, with a beep, before the page can fade
  // it out. Declared as playback (as a music app is), it is let go gently,
  // but ignores the silent switch ("transient-solo" kept the beep). Telling
  // the system no media is playing is meant to keep it from showing a player
  // in the Dynamic Island (under test).
  if (navigator.audioSession) {
    try {
      navigator.audioSession.type = 'playback';
    } catch (err) { /* left as it is */ }
  }
  function noMediaPlaying() {
    if (!navigator.mediaSession) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch (err) { /* not supported */ }
  }
  noMediaPlaying();
  setInterval(noMediaPlaying, 2000);

  document.addEventListener('visibilitychange', restSound);
  addEventListener('pagehide', restSound);
  addEventListener('pageshow', restSound);
  // An app on the Home Screen hears that it is hidden only once frozen, too
  // late; it loses the focus earlier, as the reader starts to leave it.
  if (touchDevice) {
    addEventListener('blur', restSound);
    addEventListener('focus', restSound);
  }
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

  const SDLK = { enter: 13, a: 97, s: 115 };
  const SDL_BUTTON_RIGHT = 3;

  function toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const request = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!request) return;
      // The phone keeps turning freely: held upright it gets the large print.
      Promise.resolve(request.call(root)).catch(() => {});
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

  // On a touch screen the page takes the touches on the picture and hands
  // them to the engine itself: to tell a tap (a click, sent when the finger
  // lifts) from a swipe (down: the page before, which opens the backlog; up:
  // the page after, as the mouse wheel), and, with the stage turned, because
  // the browser's coordinates are a quarter turn away from the game's.
  const SDL_BUTTON_LEFT = 1;
  let touchFrom = null; // { start, last } in game pixels, while one finger is down

  function gamePoint(touch) {
    const box = frame.getBoundingClientRect();
    const along = (value) => Math.min(1, Math.max(0, value));
    if (document.body.classList.contains('rotated')) {
      return [
        Math.round(along((touch.clientY - box.top) / box.height) * (canvas.width - 1)),
        Math.round(along(1 - (touch.clientX - box.left) / box.width) * (canvas.height - 1)),
      ];
    }
    return [
      Math.round(along((touch.clientX - box.left) / box.width) * (canvas.width - 1)),
      Math.round(along((touch.clientY - box.top) / box.height) * (canvas.height - 1)),
    ];
  }

  function onPictureTouch(event) {
    event.preventDefault();
    if (!Module) return;
    if (event.type === 'touchstart' && event.touches.length > 1) {
      touchFrom = null;
      if (event.touches.length === 2) actions.menu();
      return;
    }
    const touch = event.touches[0];
    if (touch) {
      const point = gamePoint(touch);
      Module._web_push_pointer(point[0], point[1], 0, 0);
      if (event.type === 'touchstart') touchFrom = { start: point, last: point };
      else if (touchFrom) touchFrom.last = point;
      return;
    }
    if (!touchFrom || event.type === 'touchcancel') {
      touchFrom = null;
      return;
    }
    const { start, last } = touchFrom;
    touchFrom = null;
    const dx = last[0] - start[0];
    const dy = last[1] - start[1];
    if (Math.abs(dy) > canvas.height * 0.08 && Math.abs(dy) > 1.5 * Math.abs(dx)) {
      Module._web_push_wheel(dy > 0 ? 1 : -1);
    } else if (!choicesOffPicture) { // the choices are under the text, not here
      Module._web_push_pointer(start[0], start[1], SDL_BUTTON_LEFT, 1);
      Module._web_push_pointer(start[0], start[1], SDL_BUTTON_LEFT, 0);
    }
  }

  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    touchLayer.addEventListener(type, onPictureTouch, { passive: false });
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
      ponsTextGlyph,
      ponsTextEvent,
      onAbort: (reason) => fail(`The engine stopped: ${reason}`),
      onExit: () => { location.href = './'; },
    });

    if (params.has('debug')) window.ponscripter = { Module, ponsPlayVideo, actions, stats, cache, soundFlowing, soundGuard: () => soundGuard };

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
    layout(); // also hands the engine textBelow
    canvas.focus();

    setInterval(syncSaves, 250);
    if (!params.has('nolookahead')) setInterval(lookAhead, 200);
    setInterval(showButtons, 250);
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

  startButton.addEventListener('click', () => {
    unlockMovieSound();
    start().catch(fail);
  });
  preload = loadEverything();
  preload.then(() => {
    bootStatus.textContent = 'Ready.';
    startButton.disabled = false;
  }, fail);
})();
