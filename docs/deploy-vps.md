# Deploy Gentle Dot on a VPS

This guide puts the same daemon you run locally on a server, so you can open Gentle Dot from any browser. It targets a HostGator VPS with cPanel/WHM, and also covers a plain VPS.

> Status: documented, not executed. The local setup is the supported path today.

## Before you start: what you are exposing

Gentle Dot can read and write files and run commands. On a server, whoever reaches it controls that container. Keep these rules:

- **HTTPS only.** Never expose port 4317 directly; the container binds the VPS loopback (`127.0.0.1`) on purpose.
- **Two locks.** Use the web server password (Basic Auth) *and* the Gentle Dot access key.
- **Isolated machine.** The agent works inside its container volume. Never mount your personal folders, SSH keys, or another project's data.
- **Your model key is a secret.** Keep it only in the server's `.env` file with `chmod 600`, and never commit it.

## What runs

```
browser ──HTTPS──▶ Apache (cPanel) or Caddy ──▶ 127.0.0.1:4317 ──▶ container: gentle-dot daemon
                                                                     ├─ gentle-shell (agent)
                                                                     └─ engram serve (memory)
```

The image (`Dockerfile`) installs `gentle-pi` (it provides `gentle-shell`), builds Engram, and builds the web UI. The `dot-home` volume keeps conversations, memory, the access key, and the agent login across restarts.

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
chmod 600 .env
```

Fill in one model key. If you prefer to log in to a provider instead of using a key, do it once after step 4 with `docker compose run --rm gentle-dot gentle-shell`; the login is kept in the volume.

For the Caddy option, also add `DOT_USER` and `DOT_PASSWORD_HASH`. Generate the hash with `docker run --rm caddy:2 caddy hash-password --plaintext 'your-password'`, and write every `$` as `$$`.

### 4. Build and start

```bash
docker compose up -d --build
curl -s http://127.0.0.1:4317/health     # {"ok":true,"agentState":"idle"}
docker compose logs gentle-dot | grep "Gentle Dot is running"
```

The log line prints the URL with the access key, `http://127.0.0.1:4317/#token=…`. Keep the part after `#token=`; you will open it with your domain in step 6.

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
| "The assistant is restarting" stays on | The agent cannot start; check `docker compose logs gentle-dot` for a missing model key or login. |

## Video outline (about 2 minutes)

1. "Gentle Dot runs on my Mac. Now let's put it on a HostGator VPS so I can use it from anywhere."
2. Create the `dot` subdomain in DNS (step 1).
3. `git clone` into `/opt/gentle-dot`, then create `.env` with the domain and the model key (steps 2–3).
4. `docker compose up -d --build`, then `curl` the health check (step 4).
5. In WHM: run AutoSSL, add the password file, and drop in the Apache include (step 5a).
6. Open `https://dot.<domain>/#token=…` on a phone: same assistant, same memory.
7. Close with the safety rules: HTTPS, two locks, an isolated container.
