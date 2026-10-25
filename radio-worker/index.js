// Same-origin Plex proxy for https://reecehaigh.com/radio  (hardened revision)
//
// The browser app calls `/plex/*` on its own origin; this Worker forwards each
// request to the user's Plex Media Server and fixes the response so a browser
// can read it. Plex pins `Access-Control-Allow-Origin` to https://app.plex.tv,
// so the static site cannot call a Plex server directly.
//
// Server discovery happens here (plex.tv/api/v2/resources). Relay connections
// are preferred because they are the path reachable from Cloudflare when the
// home connection has no working port forward.
//
// Changes from the first version:
//  - the resolved server is cached for 1h (was 10 min) and concurrent requests
//    share one discovery instead of each running their own (thundering herd)
//  - an expired entry is still used if re-discovery fails (stale-on-error)
//  - candidate connections are probed in parallel; LAN addresses are skipped
//  - re-discovery only happens on connection failure, a 401 from a cached
//    server token, or a gateway error (502/504) — not on any 503
//  - a rejected Plex token now returns a clean 401 (the app signs out on it)
//  - a failed request is retried once with a fresh discovery (flaky relay nodes),
//    and a 502 now says why (no addresses are ever included in the message)
//  - optional lock to one server via env.PLEX_MACHINE_ID
//  - CORS limited to https://reecehaigh.com
//
// Optional environment variable (Settings -> Variables and Secrets):
//   PLEX_MACHINE_ID  your server's machineIdentifier; when set, no other server
//                    can be reached through this Worker.

const ALLOWED_ORIGIN = "https://reecehaigh.com";
const BASE_TTL = 3600;              // seconds a resolved server is trusted
const STALE_TTL = 86400;            // seconds an expired entry may still be used if discovery fails
const PROBE_TIMEOUT = 10000;        // ms — relay nodes are slow to first byte
const METHODS = new Set(["GET", "HEAD", "PUT", "POST", "DELETE"]);

// Per-isolate memory: resolved servers by token hash, and in-flight discoveries.
const memo = new Map();      // hash -> { base, token, at }
const inflight = new Map();  // hash -> Promise<result|null|{unauthorized}>

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }
    if (!METHODS.has(request.method)) {
      return text("Method not allowed", 405, request);
    }

    const match = url.pathname.match(/^\/plex(\/.*)?$/);
    if (!match) return new Response("Not found", { status: 404 });
    const plexPath = match[1] || "/";

    const token =
      url.searchParams.get("X-Plex-Token") ||
      request.headers.get("X-Plex-Token") ||
      "";
    if (!token) return text("Missing X-Plex-Token", 401, request);

    const clientId =
      url.searchParams.get("X-Plex-Client-Identifier") || "radio-plex-proxy";

    // 1 = one automatic retry (with a fresh discovery) if the first attempt fails
    const res = await proxy(request, env, url, plexPath, token, clientId, ctx, 1);
    return res || text("Could not reach the Plex server.", 502, request);
  },
};

async function proxy(request, env, url, plexPath, callerToken, clientId, ctx, retriesLeft) {
  const resolved = await resolveBase(env, callerToken, clientId, ctx);
  if (!resolved) return null;
  if (resolved.unauthorized) return text("Plex rejected this token", 401, request);
  if (resolved.failed) {
    // Say *why*, so a 502 in the browser is diagnosable. Labels only — no addresses.
    return text(`Could not reach the Plex server:\n- ${resolved.failed.join("\n- ")}`, 502, request);
  }
  const { base, token: upstreamToken } = resolved;

  const target = new URL(base + plexPath);
  for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
  target.searchParams.set("X-Plex-Token", upstreamToken);

  const fwd = new Headers();
  for (const h of ["range", "accept", "if-range", "if-none-match", "if-modified-since", "content-type"]) {
    const v = request.headers.get(h);
    if (v) fwd.set(h, v);
  }
  fwd.set("X-Plex-Token", upstreamToken);

  // The body can only be sent once, so a retry is only safe for bodyless requests.
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const canRetry = retriesLeft > 0 && !hasBody;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers: fwd,
      body: hasBody ? request.body : undefined,
      redirect: "follow",
    });
  } catch (err) {
    if (canRetry) {
      await forget(callerToken);
      return proxy(request, env, url, plexPath, callerToken, clientId, ctx, retriesLeft - 1);
    }
    return null;
  }

  // A dead or flaky route shows up as a gateway error (502/504), or, for a
  // per-server accessToken that has rotated, a 401. Re-discover once — even if
  // the server was only just resolved: a relay node can pass the quick /identity
  // probe and still fail the real request, and a second discovery often lands
  // on a working one. A 503 is Plex being busy, not a dead route, so no retry.
  if (canRetry && [401, 502, 504].includes(upstream.status)) {
    await forget(callerToken);
    return proxy(request, env, url, plexPath, callerToken, clientId, ctx, retriesLeft - 1);
  }

  const headers = new Headers(upstream.headers);
  headers.delete("access-control-allow-origin");
  headers.delete("access-control-allow-credentials");
  for (const [k, v] of Object.entries(cors(request))) headers.set(k, v);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// Resolves the server for this token. Returns:
//   { base, token }          on success
//   { unauthorized: true }   if plex.tv rejected the token
//   { failed: [reasons] }    if nothing is reachable (reasons are address-free labels)
async function resolveBase(env, callerToken, clientId, ctx) {
  const hash = await tokenHash(callerToken);
  const now = Date.now();

  const m = memo.get(hash);
  if (m && now - m.at < BASE_TTL * 1000) return m;

  const cached = await readEdgeCache(hash);
  if (cached && now - cached.at < BASE_TTL * 1000) {
    memo.set(hash, cached);
    return cached;
  }

  // One discovery per token at a time; every concurrent request awaits it.
  let p = inflight.get(hash);
  if (!p) {
    p = discover(env, callerToken, clientId)
      .then((found) => {
        if (found && found.base) {
          const entry = { base: found.base, token: found.token, at: Date.now() };
          memo.set(hash, entry);
          ctx.waitUntil(writeEdgeCache(hash, entry));
        }
        return found;
      })
      .finally(() => inflight.delete(hash));
    inflight.set(hash, p);
  }
  const found = await p;

  if (found.base || found.unauthorized) return found;

  // Discovery failed (plex.tv blip, all probes down): fall back to the last
  // known server, even past its TTL, rather than failing outright.
  const stale = m || cached;
  if (stale && now - stale.at < STALE_TTL * 1000) return stale;
  return found; // { failed: [...] }
}

async function discover(env, callerToken, clientId) {
  const failures = [];
  let resources;
  try {
    const res = await fetch(
      "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1",
      {
        headers: {
          Accept: "application/json",
          "X-Plex-Token": callerToken,
          "X-Plex-Client-Identifier": clientId,
          "X-Plex-Product": "reecehaigh.com radio (proxy)",
          "X-Plex-Version": "1.1",
        },
      }
    );
    if (res.status === 401 || res.status === 403) return { unauthorized: true };
    if (!res.ok) return { failed: [`plex.tv returned HTTP ${res.status} when listing servers`] };
    resources = await res.json();
  } catch (e) {
    return { failed: [`could not reach plex.tv (${reason(e)})`] };
  }

  const all = (Array.isArray(resources) ? resources : []).filter((r) =>
    (r.provides || "").includes("server")
  );
  if (!all.length) return { failed: ["this Plex account has no servers (or none shared with it)"] };
  let servers = all;
  // Optional lock to a single server so this Worker can't proxy to anyone else's.
  if (env.PLEX_MACHINE_ID) {
    servers = all.filter((s) => s.clientIdentifier === env.PLEX_MACHINE_ID);
    if (!servers.length) {
      return { failed: [`PLEX_MACHINE_ID is set but matches none of this account's ${all.length} server(s) — check the value, or remove the variable`] };
    }
  }

  // Plex on `network_mode: host` advertises every Docker bridge gateway
  // (172.16.0.0/12) as a connection; none are reachable.
  const isDockerBridge = (uri) => {
    const m = uri.match(/https?:\/\/(\d+)-(\d+)-\d+-\d+\./);
    return !!m && +m[1] === 172 && +m[2] >= 16 && +m[2] <= 31;
  };

  for (const s of servers) {
    const upstreamToken = s.accessToken || callerToken;
    const seen = new Set();
    const conns = [];
    for (const c of s.connections || []) {
      // LAN addresses are never reachable from Cloudflare.
      if (!c.uri || c.local || seen.has(c.uri) || isDockerBridge(c.uri)) continue;
      seen.add(c.uri);
      conns.push(c);
    }
    if (!conns.length) {
      failures.push("server is online but advertises no relay or remote connection — enable Remote Access / Relay in Plex");
      continue;
    }

    // Probe every candidate at once; the first healthy one wins.
    try {
      const base = await Promise.any(
        conns.map(async (c) => {
          try {
            const r = await fetch(
              `${c.uri}/identity?X-Plex-Token=${encodeURIComponent(upstreamToken)}`,
              { signal: AbortSignal.timeout(PROBE_TIMEOUT) }
            );
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return c.uri.replace(/\/$/, "");
          } catch (e) {
            failures.push(`${c.relay ? "relay" : "direct"} connection: ${reason(e)}`);
            throw e;
          }
        })
      );
      return { base, token: upstreamToken };
    } catch (_) {
      /* no connection for this server answered — try the next server */
    }
  }
  return { failed: failures.length ? failures : ["no connection to the server worked"] };
}

function reason(e) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return `no answer within ${PROBE_TIMEOUT / 1000}s`;
  return e && e.message ? e.message.replace(/https?:\/\/\S+/g, "…") : "network error";
}

// ---- cache helpers ----------------------------------------------------------

async function readEdgeCache(hash) {
  try {
    const hit = await caches.default.match(edgeKey(hash));
    return hit ? JSON.parse(await hit.text()) : null;
  } catch (_) {
    return null;
  }
}

async function writeEdgeCache(hash, entry) {
  try {
    await caches.default.put(
      edgeKey(hash),
      new Response(JSON.stringify(entry), {
        headers: { "Cache-Control": `max-age=${STALE_TTL}` },
      })
    );
  } catch (_) { /* cache is best-effort */ }
}

async function forget(token) {
  const hash = await tokenHash(token);
  memo.delete(hash);
  try { await caches.default.delete(edgeKey(hash)); } catch (_) { /* ignore */ }
}

const edgeKey = (hash) => new Request(`https://radio-plex-proxy.internal/base/${hash}`);

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- responses --------------------------------------------------------------

function text(body, status, request) {
  return new Response(body, { status, headers: cors(request) });
}

function cors(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "X-Plex-Token, X-Plex-Client-Identifier, Accept, Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    Vary: "Origin",
  };
  // Same-origin requests need no CORS headers at all; only echo our own site.
  if (origin === ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
