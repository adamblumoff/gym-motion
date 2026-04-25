#!/usr/bin/env bash
set -euo pipefail

service_name="gym-motion-linux-gateway.service"
sudoers_target="/etc/sudoers.d/gym-motion-linux-gateway-admin"
current_user="${SUDO_USER:-$USER}"

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

cat > "$tmp_file" <<EOF
$current_user ALL=(root) NOPASSWD: /usr/bin/systemctl status --no-pager $service_name, /usr/bin/systemctl start $service_name, /usr/bin/systemctl stop $service_name, /usr/bin/systemctl restart $service_name, /usr/bin/journalctl -u $service_name -n 1 --no-pager, /usr/bin/journalctl -u $service_name -n 200 --no-pager
EOF

sudo install -m 440 "$tmp_file" "$sudoers_target"
sudo visudo -cf "$sudoers_target"

echo "Installed gateway admin sudoers rule for $current_user."
echo
echo "Quick checks:"
sudo -n systemctl status --no-pager "$service_name" >/dev/null && echo "  service control: ready"
sudo -n journalctl -u "$service_name" -n 1 --no-pager >/dev/null && echo "  logs: ready"
echo
echo "You can now use the desktop Gateway Admin page for status, logs, start, stop, and restart."
