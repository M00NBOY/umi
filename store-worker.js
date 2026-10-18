// Writes to the device's storage for the page (the origin private file
// system): imports a game from a zip or a folder, and keeps saves. Runs in a
// worker because only workers may write to it synchronously, which is what
// Safari supports best, and so that a 4 GB import never freezes the page.
//
// Layout, shared with store.js:
//   games/<id>/meta.json   what was imported; written last, so a game without
//                          it is an import that did not finish
//   games/<id>/index.tsv   key, stored length, compression, original length,
//                          file under data/, offset in that file
//   games/<id>/data/...    the game's files, paths in lower case
//   saves/<id>/...         saves, kept apart so that a new import keeps them
'use strict';

const SCRIPT_NAMES = ['0.utf', '0.txt', 'nscript.dat'];
// Not needed to play, at the top of the game folder: launchers, Steam files,
// and the saves (imported separately).
const SKIP_TOP_LEVEL = /^(saves|lib64|.*\.app|.*\.exe|.*\.dll|steam_appid\.txt)$/i;
const SKIP_ANYWHERE = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|steam_autocloud\.vdf)(\/|$)/i;
// Movies the browser has no way to play.
const SKIP_FILE = /\.avi$/i;
const COPY_CHUNK = 8 * 1024 * 1024;

const KNOWN_GAMES = [
  { match: /chiru|散/i, id: 'answer', title: 'Umineko When They Cry Chiru', subtitle: 'Answer Arcs · Episodes 5–8' },
  { match: /umineko|うみねこ/i, id: 'question', title: 'Umineko When They Cry', subtitle: 'Question Arcs · Episodes 1–4' },
];

class UserError extends Error {}

// ---------------------------------------------------------------- storage

async function dirAt(parts, create) {
  let dir = await navigator.storage.getDirectory();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function exists(parts) {
  try {
    await dirAt(parts, false);
    return true;
  } catch (err) {
    return false;
  }
}

async function remove(parts) {
  const parent = await dirAt(parts.slice(0, -1), true);
  try {
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }
}

/** Opens a file for writing from the start; call write(bytes) then close(). */
async function createFile(parts) {
  const dir = await dirAt(parts.slice(0, -1), true);
  const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  let at = 0;
  return {
    write(bytes) {
      let done = 0;
      while (done < bytes.length) {
        const n = access.write(done ? bytes.subarray(done) : bytes, { at: at + done });
        if (!n) throw new Error('could not write to storage');
        done += n;
      }
      at += bytes.length;
    },
    close() {
      access.flush();
      access.close();
    },
    abort() {
      try { access.close(); } catch (err) { /* already closed */ }
    },
  };
}

async function writeWhole(parts, bytes) {
  const file = await createFile(parts);
  try {
    file.write(bytes);
    file.close();
  } catch (err) {
    file.abort();
    throw err;
  }
}

async function readFile(parts) {
  const dir = await dirAt(parts.slice(0, -1), false);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

const splitPath = (path) => path.split('/').filter(Boolean);

// -------------------------------------------------------------------- zip

async function bytesOf(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** Lists a zip's files from its central directory (zip64 included). */
async function readZip(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await bytesOf(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new UserError('This file is not a zip, or it is damaged (was the download complete?).');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.getUint32(locator, true) !== 0x07064b50) throw new UserError('This zip is damaged.');
    const recordAt = Number(tail.getBigUint64(locator + 8, true));
    const record = await bytesOf(file, recordAt, recordAt + 56);
    if (record.getUint32(0, true) !== 0x06064b50) throw new UserError('This zip is damaged.');
    count = Number(record.getBigUint64(32, true));
    cdSize = Number(record.getBigUint64(40, true));
    cdOffset = Number(record.getBigUint64(48, true));
  }
  const cd = await bytesOf(file, cdOffset, cdOffset + cdSize);
  const utf8 = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new UserError('This zip is damaged.');
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLength = cd.getUint16(p + 28, true);
    const extraLength = cd.getUint16(p + 30, true);
    const commentLength = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLength));
    // Sizes too big for 32 bits are in the zip64 extra field, in this order.
    let x = p + 46 + nameLength;
    const extraEnd = x + extraLength;
    while (x + 4 <= extraEnd) {
      const id = cd.getUint16(x, true);
      const length = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) { local = Number(cd.getBigUint64(q, true)); }
      }
      x += 4 + length;
    }
    p = extraEnd + commentLength;
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) {
      throw new UserError(`${name} is packed in a way this page cannot read. Make the zip with the computer's own "Compress" command.`);
    }
    entries.push({
      path: name.replace(/\\/g, '/'),
      size,
      async *chunks() {
        const header = await bytesOf(file, local, local + 30);
        if (header.getUint32(0, true) !== 0x04034b50) throw new UserError('This zip is damaged.');
        const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const packed = file.slice(start, start + csize);
        if (method === 0) {
          yield* blobChunks(packed);
          return;
        }
        const reader = packed.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      },
    });
  }
  return entries;
}

async function* blobChunks(blob) {
  for (let at = 0; at < blob.size; at += COPY_CHUNK) {
    yield new Uint8Array(await blob.slice(at, at + COPY_CHUNK).arrayBuffer());
  }
}

/** The files chosen with a folder picker: [{ path, file }]. */
function readFolder(files) {
  return files.map(({ path, file }) => ({
    path: path.replace(/\\/g, '/'),
    size: file.size,
    chunks: () => blobChunks(file),
  }));
}

async function readAll(entry) {
  const parts = [];
  let length = 0;
  for await (const chunk of entry.chunks()) {
    parts.push(chunk);
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ----------------------------------------------------------------- import

/** Reads the table of contents of an NScripter .nsa archive. */
async function readNsaIndex(file) {
  const head = await bytesOf(file, 0, 6);
  const count = head.getUint16(0);
  const base = head.getUint32(2);
  const table = await bytesOf(file, 6, base);
  const decoder = new TextDecoder('shift_jis');
  const bytes = new Uint8Array(table.buffer, table.byteOffset, table.byteLength);
  const entries = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const end = bytes.indexOf(0, pos);
    if (end < 0) throw new UserError(`${file.name} is damaged.`);
    entries.push({
      name: decoder.decode(bytes.subarray(pos, end)),
      compression: table.getUint8(end + 1),
      offset: base + table.getUint32(end + 2),
      length: table.getUint32(end + 6),
      original: table.getUint32(end + 10),
    });
    pos = end + 14;
  }
  return entries;
}

function identify(script) {
  const head = new TextDecoder().decode(script.subarray(0, 4 * 1024 * 1024));
  const captions = [...head.matchAll(/^\s*caption\s+"([^"\n]+)"/gim)].map((m) => m[1]);
  const caption = captions.find((c) => /[a-z]/i.test(c)) || captions[0] || '';
  const known = KNOWN_GAMES.find((g) => g.match.test(caption));
  if (known) return { id: known.id, title: known.title, subtitle: known.subtitle };
  if (!caption) throw new UserError('This looks like a game folder, but not one this page knows.');
  const id = caption.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
  return { id: `other-${id}`, title: caption, subtitle: '' };
}

/** Where the game is inside what was picked: the folder holding its script. */
function findRoot(entries) {
  let best = null;
  for (const entry of entries) {
    if (SKIP_ANYWHERE.test(entry.path)) continue;
    const slash = entry.path.lastIndexOf('/');
    const name = entry.path.slice(slash + 1).toLowerCase();
    if (!SCRIPT_NAMES.includes(name)) continue;
    const root = entry.path.slice(0, slash + 1);
    if (!best || root.length < best.root.length || (root === best.root && SCRIPT_NAMES.indexOf(name) < SCRIPT_NAMES.indexOf(best.name))) {
      best = { root, name, entry };
    }
  }
  return best;
}

const formatSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.ceil(bytes / 1e6)} MB`);

async function importGame({ kind, file, files }, progress) {
  progress({ stage: 'Reading…' });
  const entries = kind === 'zip' ? await readZip(file) : readFolder(files);
  const found = findRoot(entries);
  if (!found) {
    throw new UserError('No game found in it. Pick the game folder itself (the one with "arc.nsa" and "0.utf" in it), or a zip of that folder.');
  }
  const script = await readAll(found.entry);
  const game = identify(script);

  const copy = [];
  const saves = [];
  for (const entry of entries) {
    if (!entry.path.startsWith(found.root) || SKIP_ANYWHERE.test(entry.path)) continue;
    const rel = entry.path.slice(found.root.length);
    const top = rel.split('/')[0];
    if (/^saves$/i.test(top) && rel.includes('/')) {
      saves.push({ name: rel.slice(top.length + 1), entry });
      continue;
    }
    if (SKIP_TOP_LEVEL.test(top) || SKIP_FILE.test(rel)) continue;
    if (!rel.includes('/') && !rel.includes('.')) continue; // the Linux launcher
    if (entry === found.entry) continue;
    copy.push({ rel: rel.toLowerCase(), entry });
  }
  if (!copy.some((c) => /^arc\d?\.nsa$/.test(c.rel))) {
    throw new UserError('The game\'s "arc.nsa" file is missing. Pick the whole game folder.');
  }

  const total = script.length + copy.reduce((sum, c) => sum + c.entry.size, 0);
  const estimate = await navigator.storage.estimate();
  // What this game already takes is freed first.
  const previous = await readMeta(game.id);
  const free = estimate.quota - estimate.usage + (previous ? previous.bytes : 0);
  if (free < total + 50e6) {
    throw new UserError(`Not enough room: the game needs ${formatSize(total)} and this browser lets the page use ${formatSize(Math.max(0, free))} more. Free some space on the device, or delete the other game here first.`);
  }

  await remove(['games', game.id]);
  try {
    return await copyGame(game, found, script, copy, saves, total, progress);
  } catch (err) {
    await remove(['games', game.id]).catch(() => {}); // nothing half-imported is left taking room
    throw err;
  }
}

async function copyGame(game, found, script, copy, saves, total, progress) {
  const base = ['games', game.id, 'data'];
  let done = 0;
  const started = Date.now();
  const report = (name) => progress({ stage: `Copying ${game.title}…`, done, total, name, started });

  await writeWhole([...base, found.name], script);
  done += script.length;
  for (const { rel, entry } of copy) {
    report(rel);
    const out = await createFile([...base, ...splitPath(rel)]);
    try {
      let written = 0;
      let lastReport = Date.now();
      for await (const chunk of entry.chunks()) {
        out.write(chunk);
        written += chunk.length;
        done += chunk.length;
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          report(rel);
        }
      }
      out.close();
      if (written !== entry.size) throw new UserError(`${rel} is incomplete in what was picked (was the download complete?).`);
    } catch (err) {
      out.abort();
      throw err;
    }
  }

  progress({ stage: 'Indexing…', done, total });
  const index = new Map();
  for (const { rel, entry } of copy) {
    if (/\.nsa$/.test(rel) && !rel.includes('/')) continue;
    index.set(rel, [entry.size, 0, entry.size, rel, 0]);
  }
  const archives = ['arc.nsa'];
  for (let i = 1; i < 10; i++) archives.push(`arc${i}.nsa`);
  for (const name of archives) {
    if (!copy.some((c) => c.rel === name)) {
      if (name === 'arc.nsa') continue;
      break;
    }
    for (const e of await readNsaIndex(await readFile([...base, name]))) {
      const key = e.name.replace(/\\/g, '/').toLowerCase();
      if (index.has(key)) continue;
      index.set(key, [e.length, e.compression, e.original || e.length, name, e.offset]);
    }
  }
  const lines = [];
  for (const [key, cols] of index) lines.push(`${key}\t${cols.join('\t')}`);
  await writeWhole(['games', game.id, 'index.tsv'], new TextEncoder().encode(lines.join('\n') + '\n'));

  // Progress made in the installed game, unless this device already has some.
  let savesImported = 0;
  if (saves.length && !(await hasFiles(['saves', game.id]))) {
    for (const { name, entry } of saves) {
      await writeWhole(['saves', game.id, ...splitPath(name)], await readAll(entry));
      savesImported++;
    }
  }

  const meta = { ...game, scriptName: found.name, bytes: total, files: index.size, importedAt: Date.now(), version: 1 };
  await writeWhole(['games', game.id, 'meta.json'], new TextEncoder().encode(JSON.stringify(meta)));
  return { ...meta, savesImported };
}

async function readMeta(id) {
  try {
    return JSON.parse(await (await readFile(['games', id, 'meta.json'])).text());
  } catch (err) {
    return null;
  }
}

async function hasFiles(parts) {
  if (!(await exists(parts))) return false;
  for await (const entry of (await dirAt(parts, false)).values()) { // eslint-disable-line no-unused-vars
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ calls

/**
 * Saves picked by the reader: a zip (one made by exportSaves, or of a game's
 * "saves" folder) or loose files. They are added to those already here.
 */
async function importSaves({ id, kind, file, files }) {
  const entries = kind === 'zip' ? await readZip(file) : readFolder(files);
  let count = 0;
  for (const entry of entries) {
    if (SKIP_ANYWHERE.test(entry.path)) continue;
    const parts = splitPath(entry.path);
    const at = parts.map((p) => p.toLowerCase()).lastIndexOf('saves');
    // Inside a "saves" folder the layout is kept (screenshot/ssN.bmp); else just the name.
    const name = at >= 0 ? parts.slice(at + 1) : parts.slice(-1);
    if (!name.length || name.length > 2) continue;
    await writeWhole(['saves', id, ...name], await readAll(entry));
    count++;
  }
  if (!count) throw new UserError('No save found in what was picked.');
  return count;
}

const ops = {
  importGame,
  importSaves,
  async deleteGame({ id }) {
    await remove(['games', id]);
  },
  async writeSaves({ id, saves, replace }) {
    if (replace) await remove(['saves', id]);
    for (const { name, bytes } of saves) await writeWhole(['saves', id, ...splitPath(name)], bytes);
  },
};

// Writes run one at a time: two at once could open the same file twice.
let chain = Promise.resolve();

self.onmessage = (event) => {
  const { seq, op, args } = event.data;
  const progress = (info) => self.postMessage({ seq, progress: info });
  chain = chain.then(() => ops[op](args, progress)).then(
    (result) => self.postMessage({ seq, result }),
    (err) => {
      if (!(err instanceof UserError)) console.error(err);
      const quota = err && err.name === 'QuotaExceededError';
      self.postMessage({
        seq,
        error: quota ? 'The device ran out of room for the game. Free some space, then import again.'
          : err instanceof UserError ? err.message : `Something went wrong: ${err && err.message ? err.message : err}`,
      });
    },
  );
};
