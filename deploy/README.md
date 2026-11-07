# Deployment: Hostinger VPS

Live at **https://crateyard.datallmai.com** on the Hostinger VPS (88.222.213.55).

The VPS is shared with many other apps, so Crateyard runs on its own and touches nothing else:

- `/opt/crateyard/` on the server holds `docker-compose.yml`, `.env` (the generated `PG_PASSWORD`, never committed) and `app/` (this repo's code).
- Two containers: `crateyard-app-1` (the game, on `127.0.0.1:8150` only) and `crateyard-db-1` (its own Postgres 16, data in the `crateyard_pgdata` volume). Both restart automatically.
- Nginx site `/etc/nginx/sites-available/crateyard.datallmai.com` (copy in this folder) proxies HTTPS and the `/ws` WebSocket to port 8150. Certbot renews the certificate.

`docker-compose.yml` here builds from the repo root (`build: ..`); on the server the same file sits next to `app/` and uses `build: ./app`.

## Ship an update

From the repo root on your computer:

```bash
rsync -a --delete --exclude node_modules --exclude .git ./ hostinger:/opt/crateyard/app/
ssh hostinger 'cd /opt/crateyard && docker compose up -d --build && sleep 3 && curl -s http://127.0.0.1:8150/api/health'
```

Restarting the app ends any live matches, so ship when few people are playing.

## Useful commands

```bash
ssh hostinger 'cd /opt/crateyard && docker compose logs -f app'   # server logs
ssh hostinger 'cd /opt/crateyard && docker compose ps'            # status
curl https://crateyard.datallmai.com/api/health                    # should show "store":"postgres"
```

The `hostinger` SSH alias is defined in `~/.ssh/config` (root@88.222.213.55, key `~/.ssh/hostinger`).
