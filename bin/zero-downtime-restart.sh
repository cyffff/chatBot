#!/usr/bin/env bash
# 在服务器上执行:不中断对外服务地把 group-relay 换到当前代码。
#
# 为什么需要它:cloudflared 直连 127.0.0.1:8787,systemctl restart 会有一两秒没有 listener,
# 那段时间对外一律 502 —— 桥接在飞的 AI 任务会被打断标成失败。src/server.js 用了 SO_REUSEPORT,
# 所以可以先起一个备用实例接着同一个端口,再重启主实例,最后停掉备用。
set -euo pipefail

health() {
  curl -fsS --max-time 5 http://127.0.0.1:8787/health >/dev/null 2>&1
}

wait_health() {
  for _ in $(seq 1 40); do
    if health; then return 0; fi
    sleep 0.25
  done
  echo "健康检查始终失败,放弃" >&2
  return 1
}

echo "1/4 起备用实例"
sudo -n systemctl start group-relay-standby.service
wait_health

echo "2/4 重启主实例(此刻备用在接管端口)"
sudo -n systemctl restart group-relay.service
wait_health

echo "3/4 等主实例稳定"
sleep 1
wait_health

echo "4/4 停掉备用实例"
sudo -n systemctl stop group-relay-standby.service
wait_health
echo "完成:$(sudo -n systemctl is-active group-relay.service) / 备用 $(sudo -n systemctl is-active group-relay-standby.service || true)"
