/* Export the local board for tools/build-snapshot.mjs.
 *
 * 1. Start the local server (Bolt.bat), then open http://localhost:8080/icon.svg
 *    — the same origin as the board, so the same storage, but the app does not
 *    run there, so nothing refreshes or spends API calls while you export.
 * 2. Open DevTools → Console, paste this whole file, press Enter.
 * 3. Save the downloaded bolt-dump-*.json OUTSIDE the repo, then:
 *      node tools/build-snapshot.mjs <path-to-dump>
 *      node tools/verify-snapshot.mjs <path-to-dump>
 *
 * ALLOWLIST: only the cached board entries, the watchlist, plan flags and the
 * SEC registrant map are read from localStorage. Provider API keys
 * (bar.key.*, bar.apiKey) are never read. The dump still holds spend figures
 * inside the assessment log — build-snapshot.mjs strips those — so treat the
 * dump itself as private. */
(async () => {
  const ALLOW = (k) => k.startsWith('bar.t.') || ['bar.plan', 'bar.sec', 'bar.watchlist'].includes(k);
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (ALLOW(k)) ls[k] = localStorage.getItem(k);
  }
  const readStore = async (dbName, storeName) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(dbName); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const store = db.transaction(storeName).objectStore(storeName);
    const get = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const [keys, values] = await Promise.all([get(store.getAllKeys()), get(store.getAll())]);
    db.close();
    return keys.map((k, i) => [k, values[i]]);
  };
  const dump = {
    takenAt: new Date().toISOString(),
    localStorage: ls,
    px: await readStore('bar.px', 'series'),
    fx: await readStore('bolt.fundamentals', 'facts'),
    assessments: await readStore('bolt.assessments', 'assessments'),
    consensus: await readStore('bolt.consensus', 'snapshots'),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(dump)], { type: 'application/json' }));
  a.download = `bolt-dump-${dump.takenAt.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  console.log('Exported', Object.keys(ls).length, 'localStorage entries,', dump.assessments.length, 'assessments.');
})();
