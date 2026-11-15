#!/bin/sh
# Запустить один раз: sudo sh ~/planka/setup-root.sh
set -e
D=planka.212-19-134-221.sslip.io
C=/etc/nginx/sites-available/planka
echo "server { listen 80; server_name $D; location /.well-known/acme-challenge/ { root /var/www/toi-acme; } location / { return 301 https://\$host\$request_uri; } }" > $C
ln -sf $C /etc/nginx/sites-enabled/planka
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/toi-acme -d $D --cert-name planka --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
cat >> $C <<CONF
server { listen 443 ssl; server_name $D;
ssl_certificate /etc/letsencrypt/live/planka/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/planka/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
client_max_body_size 300k;
location / { proxy_pass http://127.0.0.1:3150; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$remote_addr; proxy_read_timeout 30s; }
}
CONF
nginx -t && systemctl reload nginx
echo "Готово: https://$D"
