const PRODUCT = "reecehaigh.com radio";
const VERSION = "1.0";

// iOS Safari's address/tab bar shows and hides as you scroll, and CSS vh/dvh
// units don't reliably track that across iOS Safari versions — visualViewport
// (or innerHeight as a fallback) does. Drives the --vh custom property that
// .screen's height is calculated from.
function setViewportHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--vh", `${h * 0.01}px`);
}
setViewportHeight();
window.addEventListener("resize", setViewportHeight);
window.addEventListener("orientationchange", setViewportHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", setViewportHeight);
}

const store = {
  get clientId() {
    let id = localStorage.getItem("plex_client_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("plex_client_id", id);
    }
    return id;
  },
  get token() { return localStorage.getItem("plex_token"); },
  set token(v) { v ? localStorage.setItem("plex_token", v) : localStorage.removeItem("plex_token"); },
  get server() {
    const raw = localStorage.getItem("plex_server");
    return raw ? JSON.parse(raw) : null;
  },
  set server(v) { v ? localStorage.setItem("plex_server", JSON.stringify(v)) : localStorage.removeItem("plex_server"); },
  get musicSectionKey() { return localStorage.getItem("plex_music_section"); },
  set musicSectionKey(v) { v ? localStorage.setItem("plex_music_section", v) : localStorage.removeItem("plex_music_section"); },
  get shuffle() { return localStorage.getItem("plex_shuffle") === "1"; },
  set shuffle(v) { localStorage.setItem("plex_shuffle", v ? "1" : "0"); },
  get repeatMode() { return localStorage.getItem("plex_repeat") || "off"; },
  set repeatMode(v) { localStorage.setItem("plex_repeat", v); },
  get radioMode() { return localStorage.getItem("plex_radio") === "1"; },
  set radioMode(v) { localStorage.setItem("plex_radio", v ? "1" : "0"); },
};

// ---------- Plex OAuth ----------

async function plexLogin(statusEl) {
  // Open the popup synchronously on the click, before any await, so
  // browsers don't treat it as an unrequested popup and block it.
  const popup = window.open("", "plex-auth", "width=480,height=700");

  const headers = {
    "Accept": "application/json",
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": VERSION,
    "X-Plex-Client-Identifier": store.clientId,
  };

  statusEl.textContent = "Requesting sign-in code…";
  const pinRes = await fetch("https://plex.tv/api/v2/pins", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: "strong=true",
  });
  const pin = await pinRes.json();

  const authUrl = `https://app.plex.tv/auth#?clientID=${encodeURIComponent(store.clientId)}` +
    `&code=${encodeURIComponent(pin.code)}` +
    `&context[device][product]=${encodeURIComponent(PRODUCT)}`;

  if (popup && !popup.closed) {
    popup.location.href = authUrl;
  } else {
    window.open(authUrl, "plex-auth", "width=480,height=700");
  }
  statusEl.textContent = "Waiting for you to sign in…";

  const token = await new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(async () => {
      if (Date.now() - start > 3 * 60 * 1000) {
        clearInterval(interval);
        reject(new Error("Sign-in timed out"));
        return;
      }
      try {
        const r = await fetch(`https://plex.tv/api/v2/pins/${pin.id}`, { headers });
        const data = await r.json();
        if (data.authToken) {
          clearInterval(interval);
          resolve(data.authToken);
        }
      } catch (e) { /* keep polling */ }
    }, 2000);
  });

  if (popup && !popup.closed) popup.close();
  store.token = token;
  return token;
}

// ---------- Plex API ----------

class PlexAPI {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async get(path) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${this.baseUrl}${path}${sep}X-Plex-Token=${this.token}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Plex request failed: ${path} (${res.status})`);
    const data = await res.json();
    return data.MediaContainer;
  }

  async getRawText(path) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${this.baseUrl}${path}${sep}X-Plex-Token=${this.token}`);
    if (!res.ok) throw new Error(`Plex request failed: ${path} (${res.status})`);
    return res.text();
  }

  thumbUrl(thumbPath, size = 300) {
    if (!thumbPath) return "";
    const url = encodeURIComponent(thumbPath);
    return `${this.baseUrl}/photo/:/transcode?width=${size}&height=${size}&minSize=1&upscale=1&url=${url}&X-Plex-Token=${this.token}`;
  }

  streamUrl(part) {
    return `${this.baseUrl}${part.key}?X-Plex-Token=${this.token}`;
  }

  transcodeUrl(track) {
    const path = encodeURIComponent(`/library/metadata/${track.ratingKey}`);
    return `${this.baseUrl}/music/:/transcode/universal/start.mp3?path=${path}` +
      `&mediaIndex=0&partIndex=0&protocol=http&fastSeek=1&directPlay=0&directStream=0&audioBoost=100` +
      `&X-Plex-Client-Identifier=${store.clientId}&X-Plex-Product=${encodeURIComponent(PRODUCT)}` +
      `&X-Plex-Token=${this.token}`;
  }

  getMusicSections() {
    return this.get("/library/sections").then(c =>
      (c.Directory || []).filter(d => d.type === "artist")
    );
  }

  getArtists(sectionKey) {
    return this.get(`/library/sections/${sectionKey}/all`).then(c => c.Metadata || []);
  }

  getRecentlyAdded(sectionKey) {
    return this.get(`/library/sections/${sectionKey}/recentlyAdded`).then(c => c.Metadata || []);
  }

  getPlaylists() {
    return this.get("/playlists?playlistType=audio").then(c =>
      (c.Metadata || []).filter(p => p.playlistType === "audio")
    );
  }

  getPlaylistItems(ratingKey) {
    return this.get(`/playlists/${ratingKey}/items`).then(c => c.Metadata || []);
  }

  getFacet(sectionKey, facet, type) {
    return this.get(`/library/sections/${sectionKey}/${facet}?type=${type}`).then(c => c.Directory || []);
  }

  getFilteredItems(sectionKey, filterField, tagKey, resultType) {
    return this.get(`/library/sections/${sectionKey}/all?type=${resultType}&${filterField}=${tagKey}`).then(c => c.Metadata || []);
  }

  getTrackCount(sectionKey) {
    return this.get(`/library/sections/${sectionKey}/all?type=10&X-Plex-Container-Start=0&X-Plex-Container-Size=0`)
      .then(c => c.totalSize ?? 0);
  }

  getAllTracks(sectionKey) {
    return this.get(`/library/sections/${sectionKey}/all?type=10`).then(c => c.Metadata || []);
  }

  getFolder(sectionKey, parentId) {
    const q = parentId ? `?parent=${parentId}` : "";
    return this.get(`/library/sections/${sectionKey}/folder${q}`).then(c => c.Metadata || []);
  }

  getSonicallySimilar(ratingKey, limit = 20) {
    return this.get(`/library/metadata/${ratingKey}/nearest?type=10&limit=${limit}`).then(c => c.Metadata || []);
  }

  reportScrobble(ratingKey) {
    // Marks a track as played (view count / recently-played history in Plex
    // itself) — fire-and-forget, matches what Plexamp and the official
    // clients do once a track has mostly finished playing.
    const url = `${this.baseUrl}/:/scrobble?key=${ratingKey}&identifier=com.plexapp.plugins.library&X-Plex-Token=${this.token}`;
    fetch(url).catch(() => {});
  }

  getChildren(ratingKey) {
    return this.get(`/library/metadata/${ratingKey}/children`).then(c => c.Metadata || []);
  }

  search(sectionKey, query) {
    return this.get(`/library/sections/${sectionKey}/search?query=${encodeURIComponent(query)}&type=10`)
      .then(c => c.Metadata || []);
  }
}

// ---------- Server discovery ----------

async function discoverServer(token) {
  const res = await fetch("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", {
    headers: {
      Accept: "application/json",
      "X-Plex-Token": token,
      "X-Plex-Client-Identifier": store.clientId,
    },
  });
  const resources = await res.json();
  const servers = resources.filter(r => (r.provides || "").includes("server"));

  // Prefer local LAN connections (fastest when on the home network), then a
  // direct remote connection, and only fall back to Plex Relay last — relay
  // is bandwidth-capped and known to reset sustained streams like audio even
  // though it happily serves small metadata/image requests.
  const connScore = (c) => c.local ? 0 : (c.relay ? 2 : 1);

  const failures = [];
  for (const server of servers) {
    const conns = [...(server.connections || [])].sort((a, b) => connScore(a) - connScore(b));
    for (const conn of conns) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 6000);
        const r = await fetch(`${conn.uri}/identity?X-Plex-Token=${token}`, { signal: controller.signal });
        clearTimeout(t);
        if (r.ok) {
          console.log(`Plex: using ${conn.uri}`, { local: conn.local, relay: conn.relay });
          return { name: server.name, uri: conn.uri, relay: !!conn.relay };
        }
        failures.push(`${conn.uri} → HTTP ${r.status}`);
      } catch (e) {
        failures.push(`${conn.uri} → ${e.message}`);
      }
    }
  }
  console.warn("Plex server discovery failed for these connections:", failures);
  const err = new Error(
    servers.length
      ? `Could not reach any Plex server (${failures.length} attempted)`
      : "Your Plex account has no shared servers — check the share invite was accepted"
  );
  err.details = failures;
  throw err;
}

// ---------- App state ----------

let api = null;
let musicSectionKey = null;
let queue = [];       // current list of tracks, natural order
let order = [];       // playback order — indices into `queue`
let orderPos = -1;    // position within `order`
let shuffleOn = store.shuffle;
let repeatMode = store.repeatMode; // "off" | "all" | "one"
let scrobbledCurrent = false; // whether the current track has already been reported played to Plex
let radioOn = store.radioMode;
let folderStack = [{ parentId: null, label: "Folders" }];

const LIBRARY_CATEGORIES = [
  { id: "genre-artist", label: "Artist Genres", noun: "genres", facet: "genre", facetType: 8, filterField: "genre", resultType: 8 },
  { id: "genre-album", label: "Album Genres", noun: "genres", facet: "genre", facetType: 9, filterField: "genre", resultType: 9 },
  { id: "style", label: "Styles", noun: "styles", facet: "style", facetType: 9, filterField: "style", resultType: 9 },
  { id: "mood", label: "Moods", noun: "moods", facet: "mood", facetType: 9, filterField: "mood", resultType: 9 },
  { id: "label", label: "Record Labels", noun: "labels", facet: "studio", facetType: 9, filterField: "studio", resultType: 9 },
];

const el = (id) => document.getElementById(id);
const audio = el("audio");

function formatTime(sec) {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function fmtDuration(ms) {
  return formatTime((ms || 0) / 1000);
}

// ---------- Rendering ----------

function renderArtistCard(artist) {
  const div = document.createElement("div");
  div.className = "card artist";
  div.innerHTML = `
    <img loading="lazy" src="${api.thumbUrl(artist.thumb)}" alt="">
    <div class="card-title">${artist.title}</div>
  `;
  div.onclick = () => showArtist(artist);
  return div;
}

function renderPlaylistCard(playlist) {
  const div = document.createElement("div");
  div.className = "card";
  const count = playlist.leafCount != null ? `${playlist.leafCount} track${playlist.leafCount === 1 ? "" : "s"}` : "";
  div.innerHTML = `
    <img loading="lazy" src="${api.thumbUrl(playlist.composite || playlist.thumb)}" alt="">
    <div class="card-title">${playlist.title}</div>
    <div class="card-sub">${count}</div>
  `;
  div.onclick = () => showPlaylistDetail(playlist);
  return div;
}

function renderAlbumCard(album) {
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = `
    <img loading="lazy" src="${api.thumbUrl(album.thumb)}" alt="">
    <div class="card-title">${album.title}</div>
    <div class="card-sub">${album.parentTitle || ""}</div>
  `;
  div.onclick = () => showAlbum(album);
  return div;
}

function switchView(view) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  el(`view-${view}`).classList.remove("hidden");
  const btn = document.querySelector(`.nav-btn[data-view="${view}"]`);
  if (btn) btn.classList.add("active");
}

async function showHome() {
  switchView("home");
  const container = el("view-home");
  container.innerHTML = `<div class="section-heading">Recently Added</div><div class="grid" id="home-grid"></div>`;
  const grid = el("home-grid");
  const items = await api.getRecentlyAdded(musicSectionKey);
  items.slice(0, 24).forEach(item => grid.appendChild(renderAlbumCard(item)));
}

async function showArtists() {
  switchView("artists");
  const container = el("view-artists");
  container.innerHTML = `<div class="section-heading">Artists</div><div class="grid" id="artists-grid"></div>`;
  const grid = el("artists-grid");
  const artists = await api.getArtists(musicSectionKey);
  artists
    .sort((a, b) => a.titleSort?.localeCompare(b.titleSort) ?? a.title.localeCompare(b.title))
    .forEach(a => grid.appendChild(renderArtistCard(a)));
}

async function showAlbums() {
  switchView("albums");
  const container = el("view-albums");
  container.innerHTML = `<div class="section-heading">Albums</div><div class="grid" id="albums-grid"></div>`;
  const grid = el("albums-grid");
  const artists = await api.getArtists(musicSectionKey);
  const albumLists = await Promise.all(artists.map(a => api.getChildren(a.ratingKey)));
  const albums = albumLists.flat().sort((a, b) => (b.originallyAvailableAt || "").localeCompare(a.originallyAvailableAt || ""));
  albums.forEach(al => grid.appendChild(renderAlbumCard(al)));
}

async function showArtist(artist) {
  switchView("albums");
  const container = el("view-albums");
  container.innerHTML = `
    <button class="back-btn" id="artist-back">&larr; Back</button>
    <div class="section-heading">${artist.title}</div>
    <div class="grid" id="artist-albums-grid"></div>
  `;
  el("artist-back").onclick = showArtists;
  const grid = el("artist-albums-grid");
  const albums = await api.getChildren(artist.ratingKey);
  albums
    .sort((a, b) => (a.originallyAvailableAt || "").localeCompare(b.originallyAvailableAt || ""))
    .forEach(al => grid.appendChild(renderAlbumCard(al)));
}

async function showAlbum(album) {
  switchView("album-detail");
  const container = el("view-album-detail");
  container.innerHTML = `
    <button class="back-btn" id="album-back">&larr; Back</button>
    <div class="album-header">
      <img src="${api.thumbUrl(album.thumb, 400)}" alt="">
      <div>
        <h2>${album.title}</h2>
        <div class="sub">${album.parentTitle || ""}${album.year ? " · " + album.year : ""}</div>
      </div>
    </div>
    <div id="track-list"></div>
  `;
  el("album-back").onclick = () => showAlbums();

  const tracks = await api.getChildren(album.ratingKey);
  const list = el("track-list");
  tracks.forEach((track, i) => {
    const row = document.createElement("div");
    row.className = "track-row";
    row.dataset.ratingKey = track.ratingKey;
    row.innerHTML = `
      <div class="idx">${track.index || i + 1}</div>
      <div class="title">${track.title}</div>
      <div class="dur">${fmtDuration(track.duration)}</div>
      <button class="add-to-queue-btn" title="Add to queue">+</button>
    `;
    row.onclick = () => playQueue(tracks, i);
    wireAddToQueueButton(row, track);
    list.appendChild(row);
  });
}

async function showPlaylists() {
  switchView("playlists");
  const container = el("view-playlists");
  container.innerHTML = `<div class="section-heading">Playlists</div><div class="grid" id="playlists-grid"></div>`;
  const grid = el("playlists-grid");
  const playlists = await api.getPlaylists();
  if (!playlists.length) {
    grid.outerHTML = `<p style="color:var(--text-dim)">No playlists yet.</p>`;
    return;
  }
  playlists
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach(p => grid.appendChild(renderPlaylistCard(p)));
}

async function showPlaylistDetail(playlist) {
  switchView("playlist-detail");
  const container = el("view-playlist-detail");
  container.innerHTML = `
    <button class="back-btn" id="playlist-back">&larr; Back</button>
    <div class="section-heading">${playlist.title}</div>
    <div id="playlist-track-list"></div>
  `;
  el("playlist-back").onclick = () => showPlaylists();

  const tracks = await api.getPlaylistItems(playlist.ratingKey);
  const list = el("playlist-track-list");
  tracks.forEach((track, i) => {
    const row = document.createElement("div");
    row.className = "track-row";
    row.dataset.ratingKey = track.ratingKey;
    row.innerHTML = `
      <div class="idx">${i + 1}</div>
      <div class="title">${track.title} <span style="color:var(--text-dim)">— ${track.grandparentTitle || ""}</span></div>
      <div class="dur">${fmtDuration(track.duration)}</div>
      <button class="add-to-queue-btn" title="Add to queue">+</button>
    `;
    row.onclick = () => playQueue(tracks, i);
    wireAddToQueueButton(row, track);
    list.appendChild(row);
  });
}

function renderSimpleRow(title, sub, onClick) {
  const row = document.createElement("div");
  row.className = "simple-row";
  row.innerHTML = `
    <div>
      <div class="row-title">${title}</div>
      ${sub ? `<div class="row-sub">${sub}</div>` : ""}
    </div>
    <div class="row-chevron">&rsaquo;</div>
  `;
  row.onclick = onClick;
  return row;
}

async function showLibrary() {
  switchView("library");
  const container = el("view-library");
  container.innerHTML = `<div class="section-heading">Library</div><div id="library-rows"></div>`;
  const rows = el("library-rows");

  LIBRARY_CATEGORIES.forEach(async (cat) => {
    const row = renderSimpleRow(cat.label, "…", () => showTagList(cat));
    rows.appendChild(row);
    try {
      const tags = await api.getFacet(musicSectionKey, cat.facet, cat.facetType);
      row.querySelector(".row-sub").textContent = `${tags.length} ${cat.noun}`;
    } catch (e) {
      row.querySelector(".row-sub").textContent = "unavailable";
    }
  });

  const foldersRow = renderSimpleRow("Folders", "…", () => {
    folderStack = [{ parentId: null, label: "Folders" }];
    showFolder();
  });
  rows.appendChild(foldersRow);
  api.getFolder(musicSectionKey).then(items => {
    foldersRow.querySelector(".row-sub").textContent = `${items.length} folders`;
  });

  const tracksRow = renderSimpleRow("All Tracks", "…", () => showAllTracks());
  rows.appendChild(tracksRow);
  api.getTrackCount(musicSectionKey).then(count => {
    tracksRow.querySelector(".row-sub").textContent = `${count} tracks`;
  });
}

async function showTagList(category) {
  switchView("tag-list");
  const container = el("view-tag-list");
  container.innerHTML = `
    <button class="back-btn" id="tag-list-back">&larr; Back</button>
    <div class="section-heading">${category.label}</div>
    <div id="tag-list-rows"></div>
  `;
  el("tag-list-back").onclick = () => showLibrary();
  const rows = el("tag-list-rows");
  const tags = await api.getFacet(musicSectionKey, category.facet, category.facetType);
  tags
    .sort((a, b) => a.title.localeCompare(b.title))
    .forEach(tag => rows.appendChild(renderSimpleRow(tag.title, "", () => showTagDetail(category, tag))));
}

async function showTagDetail(category, tag) {
  switchView("tag-detail");
  const container = el("view-tag-detail");
  container.innerHTML = `
    <button class="back-btn" id="tag-detail-back">&larr; Back</button>
    <div class="section-heading">${tag.title}</div>
    <div class="grid" id="tag-detail-grid"></div>
  `;
  el("tag-detail-back").onclick = () => showTagList(category);
  const grid = el("tag-detail-grid");
  const items = await api.getFilteredItems(musicSectionKey, category.filterField, tag.key, category.resultType);
  items.forEach(item => {
    grid.appendChild(category.resultType === 8 ? renderArtistCard(item) : renderAlbumCard(item));
  });
}

async function showAllTracks() {
  switchView("all-tracks");
  const container = el("view-all-tracks");
  container.innerHTML = `<div class="section-heading">All Tracks</div><div id="all-tracks-list"></div>`;
  const list = el("all-tracks-list");
  const tracks = await api.getAllTracks(musicSectionKey);
  tracks.forEach((track, i) => {
    const row = document.createElement("div");
    row.className = "track-row";
    row.dataset.ratingKey = track.ratingKey;
    row.innerHTML = `
      <div class="idx">♪</div>
      <div class="title">${track.title} <span style="color:var(--text-dim)">— ${track.grandparentTitle || ""}</span></div>
      <div class="dur">${fmtDuration(track.duration)}</div>
      <button class="add-to-queue-btn" title="Add to queue">+</button>
    `;
    row.onclick = () => playQueue(tracks, i);
    wireAddToQueueButton(row, track);
    list.appendChild(row);
  });
}

async function showFolder() {
  switchView("folder");
  const current = folderStack[folderStack.length - 1];
  const container = el("view-folder");
  const canGoBack = folderStack.length > 1;
  container.innerHTML = `
    ${canGoBack ? `<button class="back-btn" id="folder-back">&larr; Back</button>` : ""}
    <div class="section-heading">${current.label}</div>
    <div id="folder-rows"></div>
  `;
  if (canGoBack) {
    el("folder-back").onclick = () => {
      folderStack.pop();
      showFolder();
    };
  }
  const rows = el("folder-rows");
  const items = await api.getFolder(musicSectionKey, current.parentId);
  const tracks = items.filter(i => i.type === "track");

  items.forEach(item => {
    if (item.type === "track") {
      const idx = tracks.indexOf(item);
      const row = document.createElement("div");
      row.className = "track-row";
      row.dataset.ratingKey = item.ratingKey;
      row.innerHTML = `
        <div class="idx">♪</div>
        <div class="title">${item.title}</div>
        <div class="dur">${fmtDuration(item.duration)}</div>
        <button class="add-to-queue-btn" title="Add to queue">+</button>
      `;
      row.onclick = () => playQueue(tracks, idx);
      wireAddToQueueButton(row, item);
      rows.appendChild(row);
    } else {
      const match = (item.key || "").match(/parent=(\d+)/);
      const parentId = match ? match[1] : null;
      rows.appendChild(renderSimpleRow(item.title, "", () => {
        folderStack.push({ parentId, label: item.title });
        showFolder();
      }));
    }
  });
}

async function showSearchResults(query) {
  switchView("search");
  const container = el("view-search");
  container.innerHTML = `<div class="section-heading">Results for "${query}"</div><div id="search-tracks"></div>`;
  const results = await api.search(musicSectionKey, query);
  const list = el("search-tracks");
  results.forEach((track, i) => {
    const row = document.createElement("div");
    row.className = "track-row";
    row.innerHTML = `
      <div class="idx">♪</div>
      <div class="title">${track.title} <span style="color:var(--text-dim)">— ${track.grandparentTitle || ""}</span></div>
      <div class="dur">${fmtDuration(track.duration)}</div>
      <button class="add-to-queue-btn" title="Add to queue">+</button>
    `;
    row.onclick = () => playQueue(results, i);
    wireAddToQueueButton(row, track);
    list.appendChild(row);
  });
}

// ---------- Playback ----------

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildOrder(length, startIndex) {
  const all = Array.from({ length }, (_, i) => i);
  if (!shuffleOn) return all;
  const rest = all.filter(i => i !== startIndex);
  return [startIndex, ...shuffleArray(rest)];
}

function playQueue(tracks, index) {
  queue = tracks;
  order = buildOrder(tracks.length, index);
  orderPos = shuffleOn ? 0 : index;
  playCurrent();
}

function playCurrent() {
  const track = queue[order[orderPos]];
  if (!track) return;
  const part = track.Media?.[0]?.Part?.[0];
  if (!part) return;

  audio.src = api.streamUrl(part);
  audio.play().catch(() => {});
  syncNowPlayingUI(track);
  highlightPlayingRow(track.ratingKey);
  scrobbledCurrent = false;
}

function highlightPlayingRow(ratingKey) {
  document.querySelectorAll(".track-row").forEach(r => {
    r.classList.toggle("playing", r.dataset.ratingKey === String(ratingKey));
  });
}

function setPlayIcon(isPlaying) {
  const icon = isPlaying ? "⏸" : "▶";
  el("np-play").textContent = icon;
  el("fs-play").textContent = icon;
}

function syncNowPlayingUI(track) {
  const artist = track.grandparentTitle || track.originalTitle || "";
  const artUrl = api.thumbUrl(track.parentThumb || track.thumb, 80);
  const artUrlLarge = api.thumbUrl(track.parentThumb || track.thumb, 600);

  el("np-title").textContent = track.title;
  el("np-artist").textContent = artist;
  el("np-art").src = artUrl;

  el("fs-title").textContent = track.title;
  el("fs-artist").textContent = track.parentTitle ? `${artist} — ${track.parentTitle}` : artist;
  el("fs-art").src = artUrlLarge;

  setPlayIcon(true);
  updateMediaSessionMetadata(track, artUrlLarge);
  loadLyricsForTrack(track);
  refreshQueueViewIfOpen();
}

// ---------- Lyrics ----------

let currentLyrics = null;   // [{time, text}] for whichever track last loaded successfully
let lastLyricsTrackKey = null;
let lastLyricsLineIndex = -1;

function findLyricsStreamKey(track) {
  const stream = track.Media?.[0]?.Part?.[0]?.Stream?.find(s => s.format === "lrc" || s.codec === "lrc");
  return stream?.key || null;
}

function parseLRC(text) {
  const lines = text.split("\n");
  const timeRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  const result = [];
  for (const line of lines) {
    const matches = [...line.matchAll(timeRe)];
    if (!matches.length) continue; // metadata header lines like [au:...] have no numeric time
    const lyricText = line.replace(timeRe, "").trim();
    for (const m of matches) {
      result.push({ time: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text: lyricText });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

async function loadLyricsForTrack(track) {
  lastLyricsTrackKey = track.ratingKey;
  currentLyrics = null;
  lastLyricsLineIndex = -1;
  el("fs-lyrics-toggle").classList.add("hidden");
  el("fs-lyrics-lines").innerHTML = "";

  const streamKey = findLyricsStreamKey(track);
  if (!streamKey) {
    if (fsViewMode === "lyrics") showFsView("now-playing");
    return;
  }
  try {
    const text = await api.getRawText(streamKey);
    if (lastLyricsTrackKey !== track.ratingKey) return; // track changed again while this was in flight
    currentLyrics = parseLRC(text);
    el("fs-lyrics-toggle").classList.remove("hidden");
    renderLyricsLines();
  } catch (e) {
    currentLyrics = null;
  }
}

function renderLyricsLines() {
  const container = el("fs-lyrics-lines");
  container.innerHTML = "";
  if (!currentLyrics || !currentLyrics.length) {
    container.innerHTML = `<p style="color:var(--text-dim); text-align:center;">No lyrics for this track.</p>`;
    return;
  }
  currentLyrics.forEach(line => {
    const div = document.createElement("div");
    div.className = "lyrics-line";
    div.textContent = line.text || "♪";
    container.appendChild(div);
  });
}

function updateLyricsHighlight() {
  if (!currentLyrics || !currentLyrics.length || fsViewMode !== "lyrics") return;
  const t = audio.currentTime;
  let idx = -1;
  for (let i = 0; i < currentLyrics.length; i++) {
    if (currentLyrics[i].time <= t) idx = i; else break;
  }
  if (idx === lastLyricsLineIndex) return;
  lastLyricsLineIndex = idx;
  const lines = el("fs-lyrics-lines").children;
  for (let i = 0; i < lines.length; i++) lines[i].classList.toggle("current", i === idx);
  if (idx >= 0 && lines[idx]) lines[idx].scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------- Full-screen view modes: now-playing / lyrics / queue ----------

let fsViewMode = "now-playing";

function showFsView(mode) {
  fsViewMode = mode;
  el("fs-main-view").classList.toggle("hidden", mode !== "now-playing");
  el("fs-lyrics-view").classList.toggle("hidden", mode !== "lyrics");
  el("fs-queue-view").classList.toggle("hidden", mode !== "queue");
  el("fs-lyrics-toggle").classList.toggle("active", mode === "lyrics");
  el("fs-queue-toggle").classList.toggle("active", mode === "queue");
  if (mode === "lyrics") { lastLyricsLineIndex = -1; updateLyricsHighlight(); }
  if (mode === "queue") renderQueueView();
}

// ---------- Queue management ----------

function addToQueue(track) {
  queue.push(track);
  order.push(queue.length - 1);
  showToast(`Added "${track.title}" to queue`);
  refreshQueueViewIfOpen();
}

function wireAddToQueueButton(row, track) {
  const btn = row.querySelector(".add-to-queue-btn");
  if (btn) btn.onclick = (e) => { e.stopPropagation(); addToQueue(track); };
}

function refreshQueueViewIfOpen() {
  if (fsViewMode === "queue") renderQueueView();
}

function jumpToQueuePosition(pos) {
  orderPos = pos;
  playCurrent();
}

function moveQueueItem(pos, direction) {
  const target = pos + direction;
  if (target <= orderPos || target >= order.length) return;
  [order[pos], order[target]] = [order[target], order[pos]];
  renderQueueView();
}

function removeQueueItem(pos) {
  if (pos <= orderPos) return;
  order.splice(pos, 1);
  renderQueueView();
}

function renderQueueView() {
  const list = el("fs-queue-list");
  list.innerHTML = "";
  if (!order.length) {
    list.innerHTML = `<p style="color:var(--text-dim); text-align:center; padding-top:1em;">Queue is empty.</p>`;
    return;
  }

  let sectionShown = { played: false, upNext: false };
  order.forEach((queueIdx, pos) => {
    if (pos < orderPos && !sectionShown.played) {
      sectionShown.played = true;
      const h = document.createElement("div");
      h.className = "queue-section-heading";
      h.textContent = "Played";
      list.appendChild(h);
    }
    if (pos === orderPos) {
      const h = document.createElement("div");
      h.className = "queue-section-heading";
      h.textContent = "Now Playing";
      list.appendChild(h);
    }
    if (pos === orderPos + 1) {
      const h = document.createElement("div");
      h.className = "queue-section-heading";
      h.textContent = "Up Next";
      list.appendChild(h);
    }

    const track = queue[queueIdx];
    const row = document.createElement("div");
    row.className = "queue-row" + (pos === orderPos ? " current" : "");
    const canEdit = pos > orderPos;
    row.innerHTML = `
      <div class="queue-row-main">
        <div class="queue-row-title">${track.title}</div>
        <div class="queue-row-sub">${track.grandparentTitle || ""}</div>
      </div>
      <div class="queue-row-actions">
        ${canEdit ? `<button class="q-up" title="Move up">▲</button><button class="q-down" title="Move down">▼</button><button class="q-remove" title="Remove">✕</button>` : ""}
      </div>
    `;
    row.querySelector(".queue-row-main").onclick = () => jumpToQueuePosition(pos);
    if (canEdit) {
      row.querySelector(".q-up").onclick = () => moveQueueItem(pos, -1);
      row.querySelector(".q-down").onclick = () => moveQueueItem(pos, 1);
      row.querySelector(".q-remove").onclick = () => removeQueueItem(pos);
    }
    list.appendChild(row);
  });
}

audio.addEventListener("error", () => {
  const track = queue[order[orderPos]];
  if (!track) return;
  if (audio.dataset.fallback === "1") return;
  audio.dataset.fallback = "1";
  audio.src = api.transcodeUrl(track);
  audio.play().catch(() => {});
});

audio.addEventListener("loadstart", () => { audio.dataset.fallback = ""; });

audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  el("np-seek").value = pct;
  el("fs-seek").value = pct;
  el("np-time-current").textContent = formatTime(audio.currentTime);
  el("np-time-total").textContent = formatTime(audio.duration);
  el("fs-time-current").textContent = formatTime(audio.currentTime);
  el("fs-time-total").textContent = formatTime(audio.duration);

  if ("mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: audio.currentTime,
      });
    } catch (e) { /* ignore — some browsers reject edge-case values */ }
  }

  if (!scrobbledCurrent && pct >= 90) {
    const track = queue[order[orderPos]];
    if (track) {
      scrobbledCurrent = true;
      api.reportScrobble(track.ratingKey);
    }
  }

  updateLyricsHighlight();
});

audio.addEventListener("ended", () => advance(true));
audio.addEventListener("play", () => {
  setPlayIcon(true);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => {
  setPlayIcon(false);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});

// Fetches more tracks to keep an endless "radio" queue going once the
// current queue runs out — sonically-similar tracks to whatever just played
// if Plex's analysis has data for it, falling back to a random sample of
// the library so radio mode never just silently dies.
async function extendRadioQueue() {
  const lastTrack = queue[order[order.length - 1]];
  if (!lastTrack) return [];
  try {
    const similar = await api.getSonicallySimilar(lastTrack.ratingKey, 20);
    const fresh = similar.filter(t => !queue.some(q => q.ratingKey === t.ratingKey));
    if (fresh.length) return fresh;
  } catch (e) { /* fall through to the random fallback below */ }
  try {
    const all = await api.getAllTracks(musicSectionKey);
    const fresh = all.filter(t => !queue.some(q => q.ratingKey === t.ratingKey));
    return shuffleArray(fresh).slice(0, 20);
  } catch (e) {
    return [];
  }
}

// `auto` is true when called from the "ended" event (respects repeat-one);
// manual skips via the next button always move forward regardless of it.
async function advance(auto) {
  if (auto && repeatMode === "one") {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (orderPos < order.length - 1) {
    orderPos++;
    playCurrent();
  } else if (repeatMode === "all") {
    orderPos = 0;
    playCurrent();
  } else if (radioOn) {
    const more = await extendRadioQueue();
    if (more.length) {
      const startIndex = queue.length;
      queue = queue.concat(more);
      const newIndices = more.map((_, i) => startIndex + i);
      order = order.concat(newIndices);
      orderPos++;
      playCurrent();
      showToast("📡 Radio: playing similar tracks");
    } else {
      showToast("📡 Radio ran out of tracks to suggest");
      setPlayIcon(false);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    }
  } else {
    setPlayIcon(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }
}

function prevTrack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (orderPos > 0) {
    orderPos--;
    playCurrent();
  } else {
    audio.currentTime = 0;
  }
}

function togglePlay() { audio.paused ? audio.play() : audio.pause(); }

function setShuffle(on) {
  shuffleOn = on;
  store.shuffle = on;
  if (queue.length) {
    const currentIndex = order[orderPos];
    if (on) {
      const rest = queue.map((_, i) => i).filter(i => i !== currentIndex);
      order = [currentIndex, ...shuffleArray(rest)];
      orderPos = 0;
    } else {
      order = queue.map((_, i) => i);
      orderPos = currentIndex;
    }
  }
  updateShuffleRepeatUI();
}

function cycleRepeat() {
  repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
  store.repeatMode = repeatMode;
  updateShuffleRepeatUI();
}

function toggleRadio() {
  radioOn = !radioOn;
  store.radioMode = radioOn;
  updateShuffleRepeatUI();
  if (radioOn) showToast("📡 Radio mode on — keeps playing similar tracks");
}

function updateShuffleRepeatUI() {
  [el("np-shuffle"), el("fs-shuffle")].forEach(btn => btn.classList.toggle("active", shuffleOn));
  [el("np-repeat"), el("fs-repeat")].forEach(btn => {
    btn.classList.toggle("active", repeatMode !== "off");
    btn.classList.toggle("repeat-one", repeatMode === "one");
  });
  [el("np-radio"), el("fs-radio")].forEach(btn => btn.classList.toggle("active", radioOn));
}

function openNowPlayingFull() { el("now-playing-full").classList.remove("hidden"); }
function closeNowPlayingFull() { el("now-playing-full").classList.add("hidden"); }

el("np-play").onclick = togglePlay;
el("np-next").onclick = () => advance(false);
el("np-prev").onclick = prevTrack;
el("np-shuffle").onclick = () => setShuffle(!shuffleOn);
el("np-repeat").onclick = cycleRepeat;
el("np-radio").onclick = toggleRadio;
el("np-seek").oninput = (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
};
el("np-volume").oninput = (e) => { audio.volume = e.target.value / 100; };

// Tapping anywhere on the mini-player opens the full-screen view, except the
// actual controls (buttons/sliders) — a much larger, more forgiving target
// than just the album art, especially on a phone.
el("now-playing").addEventListener("click", (e) => {
  if (e.target.closest("button, input")) return;
  openNowPlayingFull();
});

el("fs-play").onclick = togglePlay;
el("fs-next").onclick = () => advance(false);
el("fs-prev").onclick = prevTrack;
el("fs-shuffle").onclick = () => setShuffle(!shuffleOn);
el("fs-repeat").onclick = cycleRepeat;
el("fs-radio").onclick = toggleRadio;
el("fs-seek").oninput = (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
};
el("fs-collapse").onclick = closeNowPlayingFull;
el("fs-lyrics-toggle").onclick = () => showFsView(fsViewMode === "lyrics" ? "now-playing" : "lyrics");
el("fs-queue-toggle").onclick = () => showFsView(fsViewMode === "queue" ? "now-playing" : "queue");

updateShuffleRepeatUI();

// ---------- Media Session (lock-screen / hardware media key controls) ----------

function updateMediaSessionMetadata(track, artUrl) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.grandparentTitle || track.originalTitle || "",
    album: track.parentTitle || "",
    artwork: [{ src: artUrl, sizes: "600x600", type: "image/jpeg" }],
  });
}

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
  navigator.mediaSession.setActionHandler("nexttrack", () => advance(false));
  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (details.seekTime != null) audio.currentTime = details.seekTime;
  });
}

// ---------- Navigation wiring ----------

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.onclick = () => {
    const view = btn.dataset.view;
    if (view === "home") showHome();
    if (view === "artists") showArtists();
    if (view === "albums") showAlbums();
    if (view === "playlists") showPlaylists();
    if (view === "library") showLibrary();
    closeSidebar();
  };
});

function openSidebar() {
  el("sidebar").classList.add("open");
  el("sidebar-backdrop").classList.remove("hidden");
}
function closeSidebar() {
  el("sidebar").classList.remove("open");
  el("sidebar-backdrop").classList.add("hidden");
}
el("menu-toggle").onclick = openSidebar;
el("sidebar-backdrop").onclick = closeSidebar;

function showToast(message, duration = 2500) {
  const toast = el("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add("hidden"), duration);
}

// Tap the logo 7 times quickly — works on both the sidebar and mobile-bar
// version, since the mobile-bar one is what most people actually see day to day.
let logoTapCount = 0;
let logoTapResetTimer = null;
function handleLogoTap() {
  logoTapCount++;
  clearTimeout(logoTapResetTimer);
  logoTapResetTimer = setTimeout(() => { logoTapCount = 0; }, 2500);
  if (logoTapCount >= 7) {
    logoTapCount = 0;
    document.body.classList.add("disco");
    showToast("🕺 disco mode activated", 4000);
    setTimeout(() => document.body.classList.remove("disco"), 4000);
  }
}
el("sidebar-logo").addEventListener("click", handleLogoTap);
document.querySelector("#mobile-bar h1").addEventListener("click", handleLogoTap);

el("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) {
    showSearchResults(e.target.value.trim());
  }
});

el("logout-btn").onclick = () => {
  store.token = null;
  store.server = null;
  store.musicSectionKey = null;
  location.reload();
};

// ---------- Boot ----------

async function boot() {
  let token = store.token;
  if (!token) return showLogin();

  try {
    let server = store.server;
    // server.relay is only present on connections picked up after the relay-
    // avoidance fix — re-discover once for anyone with an older cached entry.
    if (!server || server.relay === undefined) {
      server = await discoverServer(token);
      store.server = server;
    }
    api = new PlexAPI(server.uri, token);

    const sections = await api.getMusicSections();
    if (!sections.length) throw new Error("No music library found on this server");

    let sectionKey = store.musicSectionKey;
    if (!sectionKey || !sections.some(s => s.key === sectionKey)) {
      sectionKey = sections[0].key;
      store.musicSectionKey = sectionKey;
    }
    musicSectionKey = sectionKey;

    const select = el("library-select");
    select.innerHTML = "";
    sections.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.key;
      opt.textContent = s.title;
      if (s.key === sectionKey) opt.selected = true;
      select.appendChild(opt);
    });
    select.onchange = () => {
      musicSectionKey = select.value;
      store.musicSectionKey = musicSectionKey;
      showHome();
    };

    el("server-info").textContent = server.relay ? `${server.name} (via relay)` : server.name;
    el("login-screen").classList.add("hidden");
    el("app").classList.remove("hidden");
    showHome();
  } catch (err) {
    console.error(err);
    store.server = null;
    showLogin(err.message, err.details);
  }
}

function showLogin(message, details) {
  el("app").classList.add("hidden");
  el("login-screen").classList.remove("hidden");
  if (message) el("login-status").textContent = message;
  const detailsEl = el("login-details");
  if (details && details.length) {
    detailsEl.textContent = details.join("\n");
    detailsEl.classList.remove("hidden");
  } else {
    detailsEl.textContent = "";
    detailsEl.classList.add("hidden");
  }
}

el("login-btn").onclick = async () => {
  const status = el("login-status");
  try {
    await plexLogin(status);
    status.textContent = "Connecting to your server…";
    boot();
  } catch (err) {
    status.textContent = err.message;
  }
};

boot();
