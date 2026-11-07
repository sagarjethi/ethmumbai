# Deploying the public demo

This runs the whole demo on one server behind a single public gateway.
It runs a throwaway local chain and a test issuer, not real Sepolia, so it holds no real funds.
Every key in it is a public Anvil test key, and the chain is deleted when the demo stops.
The approval page is a test issuer that proves nobody's humanity, and anyone who can open the dashboard can press Approve.
The contracts haven't had an external audit, so don't reuse this setup for anything with real value.

Replace `demo.example.com` everywhere below with your own subdomain.

## What is exposed

Only the gateway listens for the public, and nginx sits in front of it for TLS.
By default the gateway itself binds to `127.0.0.1:28080`.
The chain, verifiers, API, runner and test issuer bind to `127.0.0.1` on ports from `28500` to `28506`.

| Path | What it is |
|---|---|
| `/` | The website |
| `/dashboard/` | The dashboard |
| `/api/*` | Allowlisted API routes, with the admin token added on the server for read-only admin routes |
| `/runner/*` | The attack list, its results and `POST /run/:id`, with one run at a time |
| `/world/*` | The test issuer's approval page and form, and only for this demo's own callback |
| `/healthz` | Whether the gateway can reach the API |

Anything else under those prefixes gets a 403 with `{"error":"Disabled in the public demo"}`.
The allowlist is the `ROUTES` table in `apps/gateway/src/app.ts`.
Creating or revoking API keys, editing limits, reporting outcomes and paid checks through `/v1/clear/*` are all refused.

## 1. Add the DNS record

Add one `A` record, plus an `AAAA` record if the server has IPv6.

```
demo.example.com.  300  IN  A  <server IPv4 address>
```

Check that it resolves before going on.

```bash
dig +short demo.example.com
```

## 2. Install what it needs on the server

You need Foundry, Node 22.13 or newer, and pnpm 9.
You also need the contract submodules, which `--recursive` fetches.
Bun isn't needed for the demo.

```bash
git clone --recursive --branch feat/demo-deploy https://github.com/sagarjethi/ethmumbai.git demo
cd demo
pnpm install --frozen-lockfile
```

For a clone without `--recursive`, run `git submodule update --init --recursive`.

## 3. Make the settings file

The admin token below is generated once and never leaves the server.
Public mode refuses to start with `local-admin-token`, with `test-admin-token`, or with anything shorter than 32 characters.
If you leave `ADMIN_TOKEN` out, each start generates its own.

```bash
sudo install -m 600 -o "$USER" /dev/null /etc/demo-gateway.env
cat > /etc/demo-gateway.env <<CONF
PUBLIC_ORIGIN=https://demo.example.com
ADMIN_TOKEN=$(openssl rand -hex 32)
GATEWAY_PORT=28080
INTERNAL_PORT_BASE=28500
CONF
```

`PUBLIC_ORIGIN` is the only place the hostname lives, and a change needs only a restart.
The start script drops every other variable from its environment, so model keys and RPC URLs in your shell never reach the demo.

## 4. Add nginx and TLS

This adds one new `server_name` and doesn't touch any other site.
Don't edit `nginx.conf` or any existing file.

First add a port 80 block, so that certbot can prove you own the name.

```bash
sudo mkdir -p /var/www/certbot
sudo tee /etc/nginx/sites-available/demo-gateway >/dev/null <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name demo.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
CONF
sudo ln -s /etc/nginx/sites-available/demo-gateway /etc/nginx/sites-enabled/demo-gateway
sudo nginx -t && sudo systemctl reload nginx
```

If your distribution has no `sites-enabled`, put the file in `/etc/nginx/conf.d/demo-gateway.conf` instead.

Then get the certificate with `certonly`, which doesn't rewrite any nginx file.

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d demo.example.com
```

Then replace the file with the full config.

```bash
sudo tee /etc/nginx/sites-available/demo-gateway >/dev/null <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name demo.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name demo.example.com;

    ssl_certificate     /etc/letsencrypt/live/demo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/demo.example.com/privkey.pem;

    client_max_body_size 8k;

    location / {
        # No URI after the port, so the gateway sees the path exactly as the client sent it.
        proxy_pass http://127.0.0.1:28080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        # Replaces anything the client sent. The gateway rate limits by this, and only from loopback.
        proxy_set_header X-Real-IP $remote_addr;

        # The dashboard's live feed is a long-lived stream, so nothing may hold it back.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
CONF
sudo nginx -t && sudo systemctl reload nginx
```

On nginx older than 1.25, replace `http2 on;` with `listen 443 ssl http2;` on both listen lines.
Until the demo is started, the new site answers with a 502, and other sites are unaffected.

## 5. Start it

Use systemd, so that it starts again after a crash or a reboot.
Replace `deploy` and the paths with your user and clone.

```bash
sudo tee /etc/systemd/system/demo-gateway.service >/dev/null <<'CONF'
[Unit]
Description=Public demo gateway and its throwaway stack
After=network.target

[Service]
User=deploy
WorkingDirectory=/home/deploy/demo
EnvironmentFile=/etc/demo-gateway.env
Environment=PATH=/home/deploy/.foundry/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/deploy/demo/node_modules/.bin/tsx scripts/public.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
CONF
sudo systemctl daemon-reload
sudo systemctl enable --now demo-gateway
journalctl -u demo-gateway -f
```

If Node comes from nvm, add its `bin` directory to that `PATH` too.
The first start compiles the contracts, which takes a minute or more, and it's ready when the log says `Public demo is up`.

Without systemd, this does the same in one command.

```bash
set -a; source /etc/demo-gateway.env; set +a
nohup pnpm start:public > data/public.log 2>&1 &
```

## 6. Stop or restart it

With systemd, use these.

```bash
sudo systemctl stop demo-gateway
sudo systemctl restart demo-gateway
```

Without systemd, stop it by its own process id, which also stops everything it started.

```bash
kill "$(cat data/public.pid)"
```

A restart creates a new chain and an empty history, which is also the way to reset the demo.
Repeated runs slowly spend the test wallet's balance, so restart it if a scenario starts failing on funds.
Each start leaves a small database in `data/public/`, which is safe to delete while the demo is stopped.

## 7. Verify it

Run these from your own machine, not the server.

```bash
ORIGIN=https://demo.example.com

# These should all answer 200.
curl -s -o /dev/null -w '%{http_code} site\n' "$ORIGIN/"
curl -s -o /dev/null -w '%{http_code} dashboard\n' "$ORIGIN/dashboard/"
curl -s -o /dev/null -w '%{http_code} agent\n' "$ORIGIN/api/v1/admin/agent"
curl -s -o /dev/null -w '%{http_code} track record\n' "$ORIGIN/api/v1/track-record"
curl -s -o /dev/null -w '%{http_code} scenarios\n' "$ORIGIN/runner/scenarios"

# The feed should print its headers straight away and stay open for 5 seconds.
curl -sN -m 5 -i "$ORIGIN/api/v1/admin/feed"

# These should all answer 403.
curl -s -o /dev/null -w '%{http_code} create key\n' -X POST "$ORIGIN/api/v1/admin/keys" -d '{"name":"x"}'
curl -s -o /dev/null -w '%{http_code} revoke key\n' -X DELETE "$ORIGIN/api/v1/admin/keys/x"
curl -s -o /dev/null -w '%{http_code} limits\n' -X POST "$ORIGIN/api/v1/admin/limits" -d '{}'
curl -s -o /dev/null -w '%{http_code} outcomes\n' -X POST "$ORIGIN/api/v1/outcomes" -d '{}'
curl -s -o /dev/null -w '%{http_code} trailing slash\n' -X POST "$ORIGIN/api/v1/admin/keys/" -d '{"name":"x"}'
curl -s -o /dev/null -w '%{http_code} encoded\n' --path-as-is -X POST "$ORIGIN/api/v1/proofs/..%2fadmin%2fkeys" -d '{"name":"x"}'

# Nothing else should answer, so these should fail to connect.
curl -s -m 5 -o /dev/null -w '%{http_code} api port\n' "http://demo.example.com:28505/health"
curl -s -m 5 -o /dev/null -w '%{http_code} chain port\n' "http://demo.example.com:28500"
```

On the server, every port from step 3 should show `127.0.0.1` and never `0.0.0.0`.

```bash
sudo ss -ltnp | grep -E ':(28080|2850[0-6])\b'
```

Then use it in a browser.
Open `/dashboard/#lab`, press Run on "Over the limit: the owner says yes", and then press "Review with World ID" in the banner.
The approval page should say "Test issuer, not World ID", every address on the way should be on your subdomain, and it should land back on the dashboard with "Approved".
On the API keys page, creating a key should show "Disabled in the public demo".

## Known limits

- An unattended "the owner says yes" run holds the one run slot for up to 3 minutes, and other visitors see that it's still running.
- The test issuer's `iss` value stays `http://127.0.0.1:<port>` and appears in the callback URL for a moment, because it's a name inside tokens and not an address anyone fetches.
- Runs are limited to 10 a minute per client and 30 a minute overall, and proxied requests to 1200 a minute per client, which are the `DEFAULT_LIMITS` in `apps/gateway/src/app.ts`.
- The product name in the existing website and dashboard source is unchanged, and only a change to those files replaces it.
