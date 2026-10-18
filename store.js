// The games and saves kept on this device (layout in store-worker.js).
// Reading is done here; anything that writes goes through the worker.
window.ponsStore = (() => {
  'use strict';

  const supported = !!(navigator.storage && navigator.storage.getDirectory && window.Worker);

  async function dirAt(parts) {
    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return dir;
  }

  /** The file at a path, or null. */
  async function file(parts) {
    try {
      const dir = await dirAt(parts.slice(0, -1));
      return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch (err) {
      if (err.name === 'NotFoundError' || err.name === 'TypeMismatchError') return null;
      throw err;
    }
  }

  async function meta(id) {
    const f = await file(['games', id, 'meta.json']);
    return f ? JSON.parse(await f.text()) : null;
  }

  /** Every game imported on this device. */
  async function games() {
    const out = [];
    let dir;
    try {
      dir = await dirAt(['games']);
    } catch (err) {
      return out;
    }
    for await (const [id, handle] of dir.entries()) {
      if (handle.kind !== 'directory') continue;
      const m = await meta(id).catch(() => null);
      if (m) out.push(m);
    }
    return out;
  }

  /** Saves of a game: [{ name, mtime, bytes }], one folder deep at most. */
  async function saves(id) {
    const out = [];
    const visit = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          if (!prefix) await visit(handle, `${name}/`);
        } else {
          const f = await handle.getFile();
          out.push({ name: prefix + name, mtime: f.lastModified, bytes: new Uint8Array(await f.arrayBuffer()) });
        }
      }
    };
    try {
      await visit(await dirAt(['saves', id]), '');
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
    }
    return out;
  }

  let worker = null;
  let seq = 0;
  const calls = new Map();

  /** Runs a write in the worker; onProgress gets its progress reports. */
  function call(op, args, onProgress) {
    if (!worker) {
      worker = new Worker('store-worker.js');
      worker.onmessage = (event) => {
        const { seq: id, progress, result, error } = event.data;
        const c = calls.get(id);
        if (!c) return;
        if (progress) {
          if (c.onProgress) c.onProgress(progress);
          return;
        }
        calls.delete(id);
        if (error) c.reject(new Error(error));
        else c.resolve(result);
      };
    }
    return new Promise((resolve, reject) => {
      seq++;
      calls.set(seq, { resolve, reject, onProgress });
      worker.postMessage({ seq, op, args });
    });
  }

  return { supported, file, meta, games, saves, call };
})();
