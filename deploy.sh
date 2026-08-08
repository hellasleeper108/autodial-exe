#!/usr/bin/env bash
# Deploy autodial.exe to the Hetzner VPS (hermes@62.238.22.177:2222) as a
# systemd service, reverse-proxied by nginx at autodial.hellasleeper.com.
#
# Run this from your Mac, inside the autodial.exe project folder
# (/Users/schoolmac/Projects/autodial), e.g.:
#
#   chmod +x deploy.sh
#   ./deploy.sh
#
# Requires: your own SSH access to hermes@62.238.22.177:2222 (this uses
# your normal SSH agent/keys, not the claude-autodial-deploy key — that one
# is Claude's, this script is meant for you to run yourself).

set -euo pipefail

HOST="hermes@62.238.22.177"
PORT=2222
REMOTE_DIR="/home/hermes/apps/autodial"
DOMAIN="autodial.hellasleeper.com"
LE_EMAIL="hellasleeper@gmail.com"

echo "==> Ensuring remote directory exists"
ssh -p "$PORT" "$HOST" "mkdir -p '$REMOTE_DIR'"

echo "==> Syncing project files (excluding node_modules, .git)"
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'deploy.sh' \
  -e "ssh -p $PORT" \
  ./ "$HOST:$REMOTE_DIR/"

echo "==> Installing production dependencies on the server"
# Same PATH problem as the systemd unit: a non-interactive ssh command
# doesn't source .bashrc/.profile, so it never picks up wherever npm/node
# actually live (~/.local/bin here) unless we force a login shell.
ssh -p "$PORT" "$HOST" "bash -lc \"cd '$REMOTE_DIR' && npm install --omit=dev\""

echo "==> Writing systemd service (autodial.service)"
# ExecStart runs through a login shell (bash -lc) rather than a hardcoded
# node path or /usr/bin/env node. Bare systemd units get a minimal default
# PATH that does NOT include ~/.local/bin, nvm shims, etc — if node was
# installed anywhere other than /usr/bin, /usr/bin/env can't find it and
# the unit fails to start at all. A login shell picks up hermes's real
# PATH the same way an interactive SSH session would.
ssh -p "$PORT" "$HOST" "sudo tee /etc/systemd/system/autodial.service > /dev/null" <<UNIT
[Unit]
Description=AUTODIAL.EXE bridge server
After=network.target

[Service]
Type=simple
User=hermes
WorkingDirectory=$REMOTE_DIR
Environment=PORT=8734
ExecStart=/bin/bash -lc 'exec node server.js'
Restart=on-failure
RestartSec=3
# If the process crash-loops faster than this, systemd stops restarting
# it entirely (silent, total outage) instead of just flapping. The
# hardening pass in server.js (safe URL decoding, top-level error
# handlers, process-level crash guards) should mean this never gets hit
# in practice, but a generous burst window is cheap insurance.
StartLimitIntervalSec=60
StartLimitBurst=10
# Hardening: this process only needs outbound TCP to the BBS directory
# hosts/ports and inbound from nginx on localhost.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Clearing any previous failed/start-limit-hit state"
ssh -p "$PORT" "$HOST" "sudo systemctl reset-failed autodial" || true

echo "==> Enabling and starting the service"
ssh -p "$PORT" "$HOST" "sudo systemctl daemon-reload && sudo systemctl enable --now autodial && sudo systemctl restart autodial"

echo "==> Service status"
ssh -p "$PORT" "$HOST" "sudo systemctl --no-pager status autodial | head -20"

echo "==> Writing nginx site config (WebSocket-aware, long timeout for live BBS sessions)"
ssh -p "$PORT" "$HOST" "sudo tee /etc/nginx/sites-available/autodial > /dev/null" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8734;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        # BBS sessions are long-lived idle WebSocket connections — don't
        # let nginx's default 60s timeout kill them.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX

ssh -p "$PORT" "$HOST" "sudo ln -sf /etc/nginx/sites-available/autodial /etc/nginx/sites-enabled/autodial && sudo nginx -t && sudo systemctl reload nginx"

echo "==> Requesting HTTPS certificate via certbot (needs DNS for $DOMAIN already live)"
echo "    If this fails because DNS hasn't propagated yet, just re-run:"
echo "    ssh -p $PORT $HOST 'sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $LE_EMAIL'"
ssh -p "$PORT" "$HOST" "sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $LE_EMAIL" || \
  echo "    (certbot step failed — safe to ignore for now and retry later; site is live over plain HTTP in the meantime)"

echo ""
echo "==> Done. Check status with:"
echo "    ssh -p $PORT $HOST 'sudo systemctl status autodial'"
echo "    Visit http://$DOMAIN (or https:// once certbot succeeds)"
