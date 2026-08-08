#!/usr/bin/env bash
# Sets up SNI-based TLS routing on port 443 for autodial.hellasleeper.com,
# without touching the tls-honeypot's behavior for any other hostname.
#
# PREREQUISITE: tls-honeypot.py's TLS_PORTS must no longer include 443
# before you run this (it currently binds 443/8443/4443 directly). If you
# run this while the honeypot still holds 443, nginx will fail to bind and
# this script's `nginx -t` / reload step will error out loudly — safe,
# just re-run after the honeypot's port list is updated.
#
# What this does:
#   1. Loads nginx's stream module (compiled in but not loaded by default)
#   2. Adds a stream {} block: SNI == autodial.hellasleeper.com -> a new
#      loopback HTTPS vhost on 127.0.0.1:8445; everything else -> the
#      honeypot's existing listener on 127.0.0.1:8443 (unchanged).
#   3. Adds that loopback vhost, reverse-proxying to the autodial app on
#      127.0.0.1:8734 (same target the plain-HTTP vhost already uses).
#   4. Gets a real Let's Encrypt cert for autodial.hellasleeper.com via the
#      HTTP-01 challenge on port 80 (already correctly served by nginx).
#   5. Tests and reloads nginx.
#
# Run from your Mac: ./tls-router-setup.sh

set -euo pipefail

HOST="hermes@62.238.22.177"
PORT=2222
DOMAIN="autodial.hellasleeper.com"
LE_EMAIL="hellasleeper@gmail.com"
LOOPBACK_SSL_PORT=8445   # NOT 8444 - that's already web-honeypot.service's WEB_HONEYPOT_SSL_PORT

echo "==> Checking nothing already owns port 443 other than expected"
ssh -p "$PORT" "$HOST" "sudo ss -tlnp | grep ':443 ' || true"
echo "    (if tls-honeypot.py still shows here, stop - its TLS_PORTS needs 443 removed first)"

echo "==> Getting a real cert for $DOMAIN (uses the existing HTTP vhost on :80 for the challenge)"
ssh -p "$PORT" "$HOST" "sudo certbot certonly --nginx -d $DOMAIN --non-interactive --agree-tos -m $LE_EMAIL --cert-name $DOMAIN"

echo "==> Writing the loopback HTTPS vhost for autodial (127.0.0.1:$LOOPBACK_SSL_PORT)"
ssh -p "$PORT" "$HOST" "sudo tee /etc/nginx/sites-available/autodial-ssl > /dev/null" <<NGINX
# Loopback-only HTTPS vhost for autodial.hellasleeper.com. Only reachable
# via the stream{} SNI router below - never bound on a public interface.
server {
    listen 127.0.0.1:$LOOPBACK_SSL_PORT ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    access_log /var/log/nginx/autodial.access.log;
    error_log  /var/log/nginx/autodial.error.log;

    location /bridge {
        proxy_pass http://127.0.0.1:8734;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
    location / {
        proxy_pass http://127.0.0.1:8734;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
NGINX

ssh -p "$PORT" "$HOST" "sudo ln -sf /etc/nginx/sites-available/autodial-ssl /etc/nginx/sites-enabled/autodial-ssl"

echo "==> Ensuring the stream module is loaded"
ssh -p "$PORT" "$HOST" "sudo grep -q 'load_module modules/ngx_stream_module.so;' /etc/nginx/nginx.conf || sudo sed -i '1i load_module modules/ngx_stream_module.so;' /etc/nginx/nginx.conf"

echo "==> Adding the stream{} SNI router (skipped if one already exists - edit manually to update)"
ssh -p "$PORT" "$HOST" "if sudo grep -q '^stream {' /etc/nginx/nginx.conf; then echo 'stream {} block already present - not touching it, edit /etc/nginx/nginx.conf by hand if the mapping needs to change'; else sudo tee -a /etc/nginx/nginx.conf > /dev/null <<STREAM

# SNI router for port 443: real HTTPS for autodial.hellasleeper.com,
# everything else (including no SNI) forwards to the tls-honeypot's
# existing listener on 127.0.0.1:8443 - its behavior for any other
# hostname/probe is unchanged.
stream {
    map \\\$ssl_preread_server_name \\\$autodial_backend {
        $DOMAIN     127.0.0.1:$LOOPBACK_SSL_PORT;
        default     127.0.0.1:8443;
    }

    server {
        listen 443;
        listen [::]:443;
        proxy_pass \\\$autodial_backend;
        ssl_preread on;
    }
}
STREAM
fi"

echo "==> Testing nginx config"
ssh -p "$PORT" "$HOST" "sudo nginx -t"

echo "==> Reloading nginx"
ssh -p "$PORT" "$HOST" "sudo systemctl reload nginx"

echo "==> Done. Verify:"
echo "    curl -sI https://$DOMAIN | head -5        # should be your app, real cert"
echo "    (from another host) test that a random/no-SNI request to :443 still hits the honeypot as before"
