# radio-worker

Cloudflare Worker behind `reecehaigh.com/plex/*`. It proxies the radio app's Plex
requests to your server (see the header comment in `index.js`).

This folder is a **copy for version control** — nothing deploys it automatically.

## Deploying a change
1. Cloudflare dashboard -> Workers & Pages -> your Worker -> **Edit code**.
2. Before replacing anything, copy the existing code somewhere safe. Cloudflare
   also keeps **Deployments / Version history** you can roll back to.
3. Paste `index.js`, **Deploy**.
4. Optional: Settings -> Variables and Secrets -> add `PLEX_MACHINE_ID` (your
   server's machineIdentifier, from `https://plex.tv/api/v2/resources` or the
   Plex Web server settings) so only your server can be reached.
5. Check https://reecehaigh.com/radio loads and plays. If anything is off, roll back.

Keep the route as it is today (`reecehaigh.com/plex*`).
