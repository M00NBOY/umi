// Game list of the static site: imports games into the device's storage,
// and moves saves in and out of it.
(() => {
  'use strict';

  const store = window.ponsStore;
  const $ = (id) => document.getElementById(id);
  const KNOWN = [
    { id: 'question', title: 'Umineko When They Cry', subtitle: 'Question Arcs · Episodes 1–4' },
    { id: 'answer', title: 'Umineko When They Cry Chiru', subtitle: 'Answer Arcs · Episodes 5–8' },
  ];

  const formatSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  let busy = false;

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  // ------------------------------------------------------------- the list

  async function render() {
    const list = $('games');
    const imported = store.supported ? await store.games() : [];
    const byId = new Map(imported.map((g) => [g.id, g]));
    const shown = [...KNOWN, ...imported.filter((g) => !KNOWN.some((k) => k.id === g.id))];
    list.replaceChildren(...shown.map((game) => card(game, byId.get(game.id))));
    showStorage();
  }

  function card(game, meta) {
    const box = el('div', { className: meta ? 'card' : 'card missing' });
    const head = meta
      ? el('a', { className: 'game', href: `play.html?game=${encodeURIComponent(game.id)}` })
      : el('div', { className: 'game' });
    head.append(el('strong', {}, game.title), el('span', {}, game.subtitle || ''));
    head.append(el('em', {}, meta ? `On this device · ${formatSize(meta.bytes)}` : 'Not on this device yet'));
    box.append(head);
    if (!meta) return box;

    const tools = el('div', { className: 'tools' });
    const exportButton = el('button', { type: 'button', textContent: 'Export saves' });
    exportButton.onclick = () => exportSaves(game).catch((err) => alert(err.message));
    const importInput = el('input', { type: 'file', multiple: true });
    importInput.onchange = () => importSaves(game, [...importInput.files]).finally(() => { importInput.value = ''; });
    const importLabel = el('label', { className: 'button' }, 'Import saves', importInput);
    const deleteButton = el('button', { type: 'button', textContent: 'Delete' });
    deleteButton.onclick = () => deleteGame(game, meta);
    tools.append(exportButton, importLabel, deleteButton);
    box.append(tools);
    return box;
  }

  async function showStorage() {
    if (!store.supported || !navigator.storage.estimate) return;
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('storage').textContent = `This page uses ${formatSize(usage)} on this device; the browser lets it use about ${formatSize(Math.max(0, quota - usage))} more.`
      + (persisted ? ' The browser will not clear it on its own.' : '');
  }

  // ---------------------------------------------------------------- import

  function setBusy(on) {
    busy = on;
    for (const input of document.querySelectorAll('input[type=file], .tools button')) input.disabled = on;
    document.body.classList.toggle('busy', on);
  }

  let wakeLock = null;

  async function importGame(args) {
    if (busy) return;
    setBusy(true);
    const result = $('import-result');
    result.hidden = true;
    $('progress').hidden = false;
    $('progress-bar').removeAttribute('value');
    $('progress-detail').textContent = '';
    try {
      if (navigator.storage.persist) await navigator.storage.persist().catch(() => false);
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
      const meta = await store.call('importGame', args, showProgress);
      result.className = 'result';
      result.textContent = `${meta.title} is ready to play.`
        + (meta.savesImported ? ` The ${meta.savesImported} save files found in the game folder were imported too.` : '')
        + (args.kind === 'zip' ? ' You can delete the zip now.' : '');
    } catch (err) {
      result.className = 'result error';
      result.textContent = err.message;
    } finally {
      if (wakeLock) wakeLock.release().catch(() => {});
      wakeLock = null;
      $('progress').hidden = true;
      result.hidden = false;
      setBusy(false);
      render();
    }
  }

  function showProgress({ stage, done, total, started }) {
    $('progress-stage').textContent = stage;
    const bar = $('progress-bar');
    if (!total) {
      bar.removeAttribute('value');
      return;
    }
    bar.value = done / total;
    let detail = `${formatSize(done)} of ${formatSize(total)}`;
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed > 5 && done > 0 && done < total) {
      const left = Math.round((elapsed * (total - done)) / done / 60);
      detail += left >= 1 ? ` · about ${left} min left` : ' · less than a minute left';
    }
    $('progress-detail').textContent = `${detail}. Keep this page open.`;
  }

  $('pick-zip').onchange = (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) importGame({ kind: 'zip', file });
  };

  $('pick-folder').onchange = (event) => {
    const files = [...event.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    event.target.value = '';
    if (files.length) importGame({ kind: 'folder', files });
  };

  addEventListener('beforeunload', (event) => {
    if (busy) event.preventDefault();
  });

  // ----------------------------------------------------------------- saves

  async function deleteGame(game, meta) {
    if (!confirm(`Delete ${game.title} from this device? This frees ${formatSize(meta.bytes)}. Saves are kept.`)) return;
    setBusy(true);
    try {
      await store.call('deleteGame', { id: game.id });
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
      render();
    }
  }

  async function importSaves(game, files) {
    if (!files.length || busy) return;
    if (!confirm(`Add these saves to ${game.title}? Saves of the same slot on this device will be replaced.`)) return;
    setBusy(true);
    try {
      const zip = files.length === 1 && /\.zip$/i.test(files[0].name);
      const count = await store.call('importSaves', zip
        ? { id: game.id, kind: 'zip', file: files[0] }
        : { id: game.id, kind: 'files', files: files.map((file) => ({ path: file.name, file })) });
      alert(`${count} save files imported.`);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function exportSaves(game) {
    const saves = await store.saves(game.id);
    if (!saves.length) throw new Error('No saves yet for this game.');
    const blob = makeZip(saves.map((s) => ({ name: `saves/${s.name}`, bytes: s.bytes, mtime: s.mtime })));
    const day = new Date().toISOString().slice(0, 10);
    const a = el('a', { href: URL.createObjectURL(blob), download: `umineko-${game.id}-saves-${day}.zip` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ------------------------------------------------------------------- zip

  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** A zip of small files, stored without compression. */
  function makeZip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const utf8 = new TextEncoder();
    for (const file of files) {
      const name = utf8.encode(file.name);
      const date = new Date(file.mtime || Date.now());
      const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
      const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
      const crc = crc32(file.bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, file.bytes.length, true);
      local.setUint32(22, file.bytes.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local, name, file.bytes);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(12, dosTime, true);
      entry.setUint16(14, dosDate, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, file.bytes.length, true);
      entry.setUint32(24, file.bytes.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(entry, name);
      offset += 30 + name.length + file.bytes.length;
    }
    const cdSize = central.reduce((sum, p) => sum + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  // ------------------------------------------------------------------ boot

  if (!store.supported) {
    $('unsupported').hidden = false;
    $('import').hidden = true;
  }
  if (ios && !installed) $('ios-install').hidden = false;
  // Phones and tablets cannot pick a folder: only a zip there.
  const folderPicking = 'webkitdirectory' in document.createElement('input') && !ios && !matchMedia('(pointer: coarse)').matches;
  if (!folderPicking) {
    $('folder-button').hidden = true;
    $('help-folder').hidden = true;
  }
  render().catch((err) => { $('games').textContent = err.message; });

  if ('serviceWorker' in navigator) {
    // A new version of the site, just taken over from the old one: show it
    // now rather than on the next visit (only here, never during a game).
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading || busy) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
