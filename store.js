// Saves the stalking log in this GitHub repository, through the GitHub API.
// Each collection is one JSON file (a list of records, each with its "id").
// Reading needs no key. Saving needs a fine-grained GitHub token with
// "Contents: read and write" on this repository, kept in this browser only.
//
// The repository is worked out from the page address (<owner>.github.io/<repo>/),
// so the same files work in anyone's account without editing.
//
// It mimics the small part of a Firestore-style API the page uses:
//   db.collection(name).onSnapshot(cb, onError)
//   db.collection(name).doc(id?).set(body) / .delete()
//   db.collection(name).updateMany({id: patch})
//   assets.upload(blob) -> {id}

const GitHubStore = (() => {
  const REPO = (() => {
    const host = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const repo = location.pathname.split("/").filter(Boolean)[0];
    return host && repo ? { owner: host[1], repo, branch: "main" } : null;   // null: opened locally
  })();
  const FILES = { culls: "data/culls.json", sightings: "data/sightings.json", sessions: "data/sessions.json" };
  // Commit messages: "Deer: Roe buck 2026-10-18", "Sighting: Roe 2026-10-18", "Session: 2026-10-18 06:30"
  const LABEL = { culls: "Deer", sightings: "Sighting", sessions: "Session" };
  const TOKEN_KEY = "ds_github_token";
  const API = REPO ? `https://api.github.com/repos/${REPO.owner}/${REPO.repo}` : "";

  const token = {
    get() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
    set(v) { try { localStorage.setItem(TOKEN_KEY, v); } catch {} },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  function headers(extra = {}) {
    const h = { Accept: "application/vnd.github+json", ...extra };
    const t = token.get();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  // base64 <-> text, safe for any character
  const toB64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const textToB64 = text => toB64(new TextEncoder().encode(text));
  const b64ToText = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

  class StoreError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  async function getPublished(path) {
    const pub = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    if (pub.status === 404) return [];
    if (!pub.ok) throw new StoreError("unavailable", `Page said ${pub.status}`);
    return pub.json();
  }

  async function getFile(path) {
    if (!REPO) return { sha: null, list: await getPublished(path), stale: true };
    // Via the API: always current, and gives the sha a save needs.
    const r = await fetch(`${API}/contents/${path}?ref=${REPO.branch}&t=${Date.now()}`, { headers: headers(), cache: "no-store" });
    if (r.status === 404) return { sha: null, list: [] };
    if (!r.ok) {
      // No key and over GitHub's hourly limit: fall back to the published copy (can be a minute behind).
      try { return { sha: null, list: await getPublished(path), stale: true }; }
      catch { throw new StoreError(r.status === 401 ? "bad_key" : "unavailable", `GitHub said ${r.status}`); }
    }
    const body = await r.json();
    return { sha: body.sha, list: JSON.parse(b64ToText(body.content)) };
  }

  async function putFile(path, b64, sha, message) {
    if (!REPO) throw new StoreError("local", "Opened locally: saving is off");
    const r = await fetch(`${API}/contents/${path}`, {
      method: "PUT", headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message, content: b64, branch: REPO.branch, ...(sha ? { sha } : {}) }),
    });
    if (r.status === 409 || r.status === 422) throw new StoreError("conflict", "Changed elsewhere");
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new StoreError("bad_key", `GitHub refused the save (${r.status})`);
    if (!r.ok) throw new StoreError("unavailable", `GitHub said ${r.status}`);
    return (await r.json()).content.sha;
  }

  // ---------- collections held in memory, mirrored to the files
  const state = {};        // name -> { list, sha, listeners: [], loaded }
  let queue = Promise.resolve();

  function emit(name) {
    const s = state[name];
    const snap = { docs: s.list.map(d => { const { id, ...rest } = d; return { id, data: () => rest }; }) };
    for (const [cb] of s.listeners) cb(snap);
  }

  async function load(name) {
    const s = state[name];
    try {
      const f = await getFile(FILES[name]);
      s.list = f.list; s.sha = f.sha; s.loaded = true;
      emit(name);
    } catch (e) {
      for (const [, err] of s.listeners) err && err(e);
    }
  }

  // Apply a change to the latest copy of a file and save it. Saves run one at a time.
  function mutate(name, change, message) {
    const run = async () => {
      const s = state[name];
      for (let attempt = 0; attempt < 3; attempt++) {
        let { list, sha } = s;
        if (attempt > 0 || !sha) ({ list, sha } = await getFile(FILES[name]));
        const next = change(list.map(d => ({ ...d })));
        try {
          s.sha = await putFile(FILES[name], textToB64(JSON.stringify(next, null, 1) + "\n"), sha, message);
          s.list = next;
          emit(name);
          return;
        } catch (e) {
          if (e.code !== "conflict" || attempt === 2) throw e;
        }
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const db = {
    collection(name) {
      if (!FILES[name]) throw new Error(`Unknown collection ${name}`);
      state[name] = state[name] || { list: [], sha: null, listeners: [], loaded: false };
      return {
        onSnapshot(cb, onError) {
          const s = state[name];
          s.listeners.push([cb, onError]);
          if (s.loaded) emit(name); else if (s.listeners.length === 1) load(name);
          return () => { s.listeners = s.listeners.filter(l => l[0] !== cb); };
        },
        doc(id) {
          id = id || newId();
          return {
            id,
            set: body => mutate(name, list => {
              const i = list.findIndex(d => d.id === id);
              const doc = { id, ...body };
              if (i >= 0) list[i] = doc; else list.push(doc);
              return list;
            }, `${LABEL[name]}: ${name === "sessions" ? "" : body.species || ""} ${name === "culls" ? body.sex || "" : ""} ${body.date || ""} ${name === "sessions" ? body.time || "" : ""}`.replace(/\s+/g, " ").trim()),
            delete: () => mutate(name, list => list.filter(d => d.id !== id), `Delete ${LABEL[name].toLowerCase()}`),
          };
        },
        // Several field updates in one save: {id: patch}
        updateMany: patches => mutate(name, list => list.map(d => patches[d.id] ? { ...d, ...patches[d.id] } : d),
          `Conditions for ${Object.keys(patches).length} ${name === "culls" ? "deer" : name}`),
      };
    },
  };

  const assets = {
    async upload(blob) {
      const id = `${newId()}.jpg`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await putFile(`photos/${id}`, toB64(bytes), null, "Photo");
      return { id };
    },
  };
  const photoUrl = id => REPO
    ? `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/photos/${encodeURIComponent(id)}`
    : `photos/${encodeURIComponent(id)}`;

  // Is the saved key good for saving here? true, false (bad key), or null (no key, or can't tell).
  async function checkKey() {
    if (!token.get() || !REPO) return null;
    try {
      const r = await fetch(API, { headers: headers(), cache: "no-store" });
      if (!r.ok) return false;
      const body = await r.json();
      return !!(body.permissions && body.permissions.push);
    } catch { return null; }
  }

  return { db, assets, photoUrl, token, checkKey, REPO };
})();
