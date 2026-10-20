#!/usr/bin/env node
import { issuePass } from "../src/network-policy.js";

// 给某个人发一条通行链接(见 README「访问防火墙」):
//   GROUP_RELAY_PASS_SECRET=... node bin/issue-pass.js --label alice [--days 90] [--base https://relay.example.com]
// 链接就是凭证,只发给本人;吊销用 GROUP_RELAY_PASS_REVOKED=alice,换 GROUP_RELAY_PASS_SECRET 则全部作废。

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

try {
  const token = issuePass({
    secret: process.env.GROUP_RELAY_PASS_SECRET,
    label: option("label"),
    days: option("days") === undefined ? 90 : Number(option("days"))
  });
  const base = String(option("base") ?? process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  console.log(`${base}/api/pass/${token}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
