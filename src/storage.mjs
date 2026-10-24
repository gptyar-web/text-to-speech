let connection;
function database() {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('ava-studio-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('state');
      request.result.createObjectStore('chunks');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('لطفاً تب دیگر آوا را ببندید و صفحه را تازه کنید.'));
  });
}

async function transaction(stores, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    try { result = action(tx); } catch (error) { tx.abort(); reject(error); return; }
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('ذخیره‌سازی انجام نشد.'));
  });
}

export const getState = key => transaction(['state'], 'readonly', tx => tx.objectStore('state').get(key));
export const setState = (key, value) => transaction(['state'], 'readwrite', tx => tx.objectStore('state').put(value, key));
export const getParts = () => transaction(['chunks'], 'readonly', tx => tx.objectStore('chunks').getAll());
export const resetJob = job => transaction(['state', 'chunks'], 'readwrite', tx => {
  tx.objectStore('chunks').clear();
  if (job) tx.objectStore('state').put(job, 'job');
  else tx.objectStore('state').delete('job');
});

// Audio and its checkpoint commit together, so resuming cannot duplicate or skip a chunk.
export const commitPart = (index, blob, job) => transaction(['state', 'chunks'], 'readwrite', tx => {
  tx.objectStore('chunks').put(blob, index);
  tx.objectStore('state').put(job, 'job');
});
