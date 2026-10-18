// Where the player page gets the game from: the copy imported on this device
// (store.js). The calls are described in the server's source.js.
window.ponsSource = (() => {
  'use strict';

  const store = window.ponsStore;
  let gameId = '';
  let entries = new Map(); // key -> [file under data/, offset, length]
  const files = new Map(); // file under data/ -> Promise<File>
  let movieUrl = null;

  const gone = () => Object.assign(new Error('game files missing'), {
    userMessage: 'The game is no longer on this device — import it again from the game list',
  });

  function dataFile(name) {
    let promise = files.get(name);
    if (!promise) {
      promise = store.file(['games', gameId, 'data', ...name.split('/')]);
      files.set(name, promise);
      promise.catch(() => files.delete(name));
    }
    return promise;
  }

  return {
    async open(id) {
      gameId = id;
      if (!store.supported) throw new Error('This browser cannot keep the game on this device.');
      const meta = await store.meta(id);
      if (!meta) throw new Error('This game has not been imported on this device yet: go back to the game list to import it.');
      const [index, script, saves] = await Promise.all([
        store.file(['games', id, 'index.tsv']),
        store.file(['games', id, 'data', meta.scriptName]),
        store.saves(id),
      ]);
      if (!index || !script) throw new Error('The game is only partly on this device: import it again from the game list.');
      const manifest = new Uint8Array(await index.arrayBuffer());
      entries = new Map();
      for (const line of new TextDecoder().decode(manifest).split('\n')) {
        const cols = line.split('\t');
        if (cols.length >= 6) entries.set(cols[0], [cols[4], Number(cols[5]), Number(cols[1])]);
      }
      return {
        title: meta.title,
        manifest, // the engine reads the first four columns
        script: new Uint8Array(await script.arrayBuffer()),
        scriptName: meta.scriptName,
        saves,
      };
    },

    async read(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      const [name, offset, length] = entry;
      const file = await dataFile(name);
      if (!file) throw gone();
      try {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      } catch (err) {
        files.delete(name); // a stale handle: open the file again on the retry
        throw err;
      }
    },

    async writeSave(name, bytes) {
      // A save is a few KB: written in well under a second when all is well.
      await store.call('writeSaves', { id: gameId, saves: [{ name, bytes }] }, null, 5000);
    },

    /**
     * Browsers cannot play the game's own movies (MPEG-1, WMV): an MP4 of
     * the same name put in the game's "movie" folder before importing is
     * played instead (the server version makes them with ffmpeg).
     */
    async movieUrl(name) {
      const entry = entries.get(`movie/${name}.mp4`);
      if (!entry) return null;
      const file = await dataFile(entry[0]);
      if (!file) return null;
      if (movieUrl) URL.revokeObjectURL(movieUrl);
      movieUrl = URL.createObjectURL(file.slice(entry[1], entry[1] + entry[2], 'video/mp4'));
      return movieUrl;
    },
  };
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
