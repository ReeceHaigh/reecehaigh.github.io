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
  throw new Error(`Could not reach any Plex server (${failures.length} attempted — see console for details)`);
}

// ---------- App state ----------

let api = null;
let musicSectionKey = null;
let queue = [];       // current list of tracks, natural order
let order = [];       // playback order — indices into `queue`
let orderPos = -1;    // position within `order`
let shuffleOn = store.shuffle;
let repeatMode = store.repeatMode; // "off" | "all" | "one"

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
    `;
    row.onclick = () => playQueue(tracks, i);
    list.appendChild(row);
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
    `;
    row.onclick = () => playQueue(results, i);
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

// `auto` is true when called from the "ended" event (respects repeat-one);
// manual skips via the next button always move forward regardless of it.
function advance(auto) {
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

function updateShuffleRepeatUI() {
  [el("np-shuffle"), el("fs-shuffle")].forEach(btn => btn.classList.toggle("active", shuffleOn));
  [el("np-repeat"), el("fs-repeat")].forEach(btn => {
    btn.classList.toggle("active", repeatMode !== "off");
    btn.classList.toggle("repeat-one", repeatMode === "one");
  });
}

function openNowPlayingFull() { el("now-playing-full").classList.remove("hidden"); }
function closeNowPlayingFull() { el("now-playing-full").classList.add("hidden"); }

el("np-play").onclick = togglePlay;
el("np-next").onclick = () => advance(false);
el("np-prev").onclick = prevTrack;
el("np-shuffle").onclick = () => setShuffle(!shuffleOn);
el("np-repeat").onclick = cycleRepeat;
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
el("fs-seek").oninput = (e) => {
  if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
};
el("fs-collapse").onclick = closeNowPlayingFull;

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
    showLogin(err.message);
  }
}

function showLogin(message) {
  el("app").classList.add("hidden");
  el("login-screen").classList.remove("hidden");
  if (message) el("login-status").textContent = message;
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
