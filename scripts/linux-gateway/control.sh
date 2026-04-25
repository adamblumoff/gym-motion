#!/usr/bin/env bash
set -euo pipefail

service_name="gym-motion-linux-gateway.service"

command="${1:-}"

if [[ -z "$command" ]]; then
  echo "Usage: $0 <install|publish|check|start|stop|restart|status|logs>"
  exit 1
fi

case "$command" in
  install)
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    exec "$script_dir/install-systemd.sh"
    ;;
  publish)
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    exec "$script_dir/publish.sh"
    ;;
  check)
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    exec "$script_dir/check.sh"
    ;;
  start)
    exec sudo systemctl start "$service_name"
    ;;
  stop)
    exec sudo systemctl stop "$service_name"
    ;;
  restart)
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    "$script_dir/publish.sh"
    exec sudo systemctl restart "$service_name"
    ;;
  status)
    exec systemctl status --no-pager "$service_name"
    ;;
  logs)
    exec journalctl -u "$service_name" -f
    ;;
  *)
    echo "Unsupported command: $command"
    echo "Usage: $0 <install|publish|check|start|stop|restart|status|logs>"
    exit 1
    ;;
esac
