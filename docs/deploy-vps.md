# Deploy Gentle Dot on a VPS

This guide puts the same daemon you run locally on a server, so you can open Gentle Dot from any browser. It targets a HostGator VPS with cPanel/WHM, and also covers a plain VPS.

> Status: documented, not executed. The local setup is the supported path today.

## Before you start: what you are exposing

Gentle Dot can read and write files and run commands. On a server, whoever reaches it controls that container. Keep these rules:

- **HTTPS only.** Never expose port 4317 directly; the container binds the VPS loopback (`127.0.0.1`) on purpose.
- **Two locks.** Use the web server password (Basic Auth) *and* the Gentle Dot access key.
- **Isolated machine.** The agent works inside its container volume. Never mount your personal folders, SSH keys, or another project's data.
- **Your model key is a secret.** Keep it only in the server's `.env` file with `chmod 600`, and never commit it.
- **A PIN for what matters.** In the browser, connecting or changing a connector and allowing an action that sends something need a PIN you set the first time. The assistant never sees it.

## What runs

```
browser ──HTTPS──▶ Apache (cPanel) or Caddy ──▶ 127.0.0.1:4317 ──▶ container: gentle-dot daemon
                                                                     ├─ gentle-shell (agent)
                                                                     └─ engram serve (memory)
```

The image (`Dockerfile`) installs `gentle-pi` (it provides `gentle-shell`) and the matching `pi`, builds Engram, and builds the web UI. On its first start the container installs the assistant's companion packages, which takes about 15 seconds and needs internet access. The `dot-home` volume keeps conversations, memory, the access key, the agent login, and the encrypted connector secrets across restarts.

### What runs as whom

The image runs in server mode (`GENTLE_DOT_VPS=1`). The assistant has a shell, so it is kept away from the daemon's files by the operating system, not by checks:

| Process | User | Reaches |
|---|---|---|
| Daemon (`node …/cli.ts`) | `root` in the container, with only the capabilities below | Everything in the volume |
| Agent, its tools and shell, its subagents, and its memory server | `dot` | Its own folders: `agent`, `home`, `workspace`, `sessions`, `gentle-ai` under `/home/dot/.gentle-dot`, and `/home/dot/.engram` |
| Connector servers the daemon starts (stdio, for example Discord) | `dotmcp` | Only its own home and working folder, `/home/dot/.gentle-dot/connector-home` |
| Sign-in helper (the daemon's own entry point with `--auth-helper`) | `dot` | The agent's sign-ins: `auth.json`, `models.json`, `settings.json` |

- The daemon never opens the agent's files as `root`. Account sign-in runs in a helper started as `dot`, because a stored key may be a command (`!…`) or a variable (`$…`) that the sign-in code resolves; whatever it runs, it runs as `dot`. Everything else the daemon reads or writes in the agent's folders (settings, profiles, `mcp.json`, history, uploads, the workspace's memory setting) it does with `dot` as its effective user, so a link the agent planted there leads nowhere `dot` could not reach anyway, and what it creates belongs to `dot`.
- The data folder `/home/dot/.gentle-dot` is `root`'s with mode `0711`: the agent can reach its own folders by name but cannot list the folder or read the access key (`token`), `connectors.json`, the encrypted secrets (`secrets.enc.json`), or the PIN hash (`web-pin.json`), all `root`'s with mode `0600`. The daemon's code in `/app` is `root`'s and read-only for everyone else.
- Connector servers run as `dotmcp`, with their own home and working folder in `connector-home`, so they cannot see the agent's workspace: a server that works on files there (for example a filesystem MCP server pointed at the workspace) does not work on a server. The agent cannot read their environment, where their token is.
- Connector secrets (sign-ins, bot tokens, client secrets) are encrypted at rest with AES-256-GCM, each with its own nonce, under `GENTLE_DOT_SECRETS_KEY` (step 3). Only the daemon's environment holds it: it is never written to the volume and never passed to the agent or a connector server. Without it, connectors that need a secret stay off and say why. Secrets an older version kept in plain files move into the encrypted file once, at the first start with the key. Anyone who opens a shell in the container (`docker compose exec`) also gets it in their environment, as with every variable from `.env`.
- `connectors.json` is signed with a key kept in the same encrypted store, so a change made behind the daemon's back is set aside at the next start.
- The daemon keeps only these capabilities (`compose.yaml`), and `no-new-privileges` is on; the agent and connector servers run with none:

| Capability | Why the daemon needs it |
|---|---|
| `SETUID`, `SETGID` | Start the agent as `dot` and connector servers as `dotmcp`, without supplementary groups |
| `CHOWN` | At start, hand the agent the files an older image left owned by root (`chown -R -P --from=0:0`) |
| `FOWNER` | At start, set the modes of folders it does not own (`connector-home`, the agent's folders) |
| `DAC_OVERRIDE` | Reach and watch the agent's private folders as root; their contents are opened only as `dot` |
| `KILL` | Stop the agent and connector servers, which run as other users |

## Steps

### 1. Point a subdomain at the VPS

Create an `A` record, for example `dot.example.com`, pointing to the VPS. Wait until it resolves:

```bash
dig +short dot.example.com
```

### 2. Get the code on the server

```bash
sudo mkdir -p /opt/gentle-dot && sudo chown "$USER" /opt/gentle-dot
git clone <your-repository-url> /opt/gentle-dot
cd /opt/gentle-dot
```

### 3. Create `.env`

```bash
cat > .env <<'EOF'
DOT_DOMAIN=dot.example.com
DOT_PORT=4317
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
EOF
echo "GENTLE_DOT_SECRETS_KEY=$(openssl rand -base64 32)" >> .env
chmod 600 .env
```

`GENTLE_DOT_SECRETS_KEY` encrypts the connectors' secrets. Keep a copy of `.env` somewhere safe outside the server: a backup of the volume without this key cannot open them, and losing it means signing in to every connector again.

Fill in one model key, or leave both empty and sign in from the browser once Gentle Dot is open (step 6): open **Accounts**, or type `/login` in the chat, and choose a subscription or an API key. The sign-in is kept in the volume.

For the Caddy option, also add `DOT_USER` and `DOT_PASSWORD_HASH`. Generate the hash with `docker run --rm caddy:2 caddy hash-password --plaintext 'your-password'`, and write every `$` as `$$`.

### 4. Build and start

```bash
docker compose up -d --build
curl -s http://127.0.0.1:4317/health     # {"ok":true,"agentState":"idle"}
docker compose exec gentle-dot cat /home/dot/.gentle-dot/token
```

The last command prints the access key; you will open it with your domain in step 6. The logs never show it: `docker compose logs gentle-dot` only says where the key file is.

### 5a. HostGator VPS (cPanel/WHM): Apache in front

cPanel's Apache already owns ports 80 and 443, so Apache proxies to the container:

1. Issue the certificate for the subdomain with AutoSSL in WHM, or with the server's usual Certbot method.
2. Create the password file:
   ```bash
   sudo htpasswd -c /etc/apache2/gentle-dot.htpasswd me
   ```
3. Copy `docker/apache-gentle-dot.conf` into the HTTPS include folder for the subdomain, for example `/etc/apache2/conf.d/userdata/ssl/2_4/<cpanel-user>/dot.example.com/gentle-dot.conf`. Change the port if you changed `DOT_PORT`.
4. Rebuild and restart Apache:
   ```bash
   sudo /scripts/rebuildhttpdconf && sudo /scripts/restartsrv_httpd
   ```

### 5b. Plain VPS: Caddy in front

```bash
docker compose --profile caddy up -d
```

Caddy obtains the HTTPS certificate on its own and asks for the `DOT_USER` password.

### 6. Open it

Open `https://dot.example.com/#token=<your access key>`. The browser asks for the web server password first, then the page stores the access key and removes it from the address bar.

If you left the model keys empty in step 3, sign in now: open **Accounts** (or type `/login`), pick a subscription or an API key, and follow the steps on screen.

The first time you connect a connector or change what it may do, the page asks you to create a PIN (6 to 12 digits). From then on, connecting, disconnecting, removing, switching a connector to read and send, importing servers, and allowing an action that sends something (an email, a message, a page) ask for it. Declining needs no PIN. After 5 wrong PINs in a row it locks for 15 minutes, also across restarts.

## Update, back up, roll back

```bash
cd /opt/gentle-dot
git pull --ff-only && docker compose up -d --build                        # update
docker run --rm -v gentle-dot_dot-home:/data -v "$PWD":/backup busybox \
  tar czf /backup/dot-home-$(date +%F).tgz -C /data .                     # back up the volume
git checkout <previous-commit> && docker compose up -d --build            # roll back
```

Never run `docker compose down -v`: `-v` deletes the volume with your conversations and memory.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The page says the link is not valid | Wrong or old access key. Read it with `docker compose exec gentle-dot cat /home/dot/.gentle-dot/token`. |
| The page loads but never connects | The proxy does not forward WebSockets (enable `mod_proxy_wstunnel`), or `DOT_DOMAIN` does not match the address you opened, so the Origin check refuses it. |
| You want no usage metrics | The companion packages send anonymous usage metrics by default. Opt out with `docker compose exec gentle-dot gentle-ai telemetry disable`. |
| "The assistant is restarting" stays on | The agent cannot start; check `docker compose logs gentle-dot` for the reason. |
| "Connect an AI account first" | No account is connected. Open **Accounts** (or type `/login`) and sign in, or add a model key to `.env` and run `docker compose up -d`. |
| "Connectors that need a secret are off on this server" | `GENTLE_DOT_SECRETS_KEY` is missing or not 32 bytes. Add it to `.env` (step 3) and run `docker compose up -d`. |
| "The stored connector secrets cannot be opened" | The key changed. Put the old one back in `.env`, or remove the secrets and sign in to the connectors again: `docker compose exec gentle-dot rm /home/dot/.gentle-dot/secrets.enc.json`. |
| You forgot the PIN | Remove it on the server, then set a new one in the browser: `docker compose exec gentle-dot rm /home/dot/.gentle-dot/web-pin.json`. |
| "Server mode … needs the daemon to run as root" | The container was started as another user (`user:` in compose, `docker run -u`). Remove that; the daemon starts the agent as `dot` itself. |

## Video outline (about 2 minutes)

1. "Gentle Dot runs on my Mac. Now let's put it on a HostGator VPS so I can use it from anywhere."
2. Create the `dot` subdomain in DNS (step 1).
3. `git clone` into `/opt/gentle-dot`, then create `.env` with the domain and the model key (steps 2–3).
4. `docker compose up -d --build`, `curl` the health check, and read the access key from the container (step 4).
5. In WHM: run AutoSSL, add the password file, and drop in the Apache include (step 5a).
6. Open `https://dot.<domain>/#token=…` on a phone, and sign in from **Accounts** if there is no model key: same assistant, same memory.
7. Close with the safety rules: HTTPS, two locks, an isolated container, and a PIN the assistant never sees.
