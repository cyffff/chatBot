import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { translate, normalizeLocale, localeFromAcceptLanguage } from "../src/i18n.js";
import { t, applyLocale, translations } from "../public/i18n.js";

/// 这一条是防「翻了一半」的闸:界面上任何一条 t("…") 或 index.html 里的中文文案,
/// 只要没有英文对照,英文用户就会看到中英混排。所以把源码里的 key 全扫出来跟字典对账。
async function clientKeys() {
  const keys = new Set();
  for (const file of ["public/app.js", "public/history.js"]) {
    const source = await fs.readFile(file, "utf8");
    const pattern = /\bt\("((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = pattern.exec(source))) keys.add(JSON.parse(`"${match[1]}"`));
  }
  const html = (await fs.readFile("public/index.html", "utf8"))
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, "");
  const cjk = /[一-鿿]/;
  for (const [, chunk] of html.matchAll(/>([^<>]+)</g)) {
    const value = chunk.trim().replace(/\s+/g, " ");
    if (value && cjk.test(value)) keys.add(value);
  }
  for (const name of ["placeholder", "title", "aria-label", "alt"]) {
    for (const [, value] of html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))) {
      if (cjk.test(value)) keys.add(value.trim());
    }
  }
  return [...keys];
}

test("every Chinese string the client shows has an English translation", async () => {
  const keys = await clientKeys();
  assert.ok(keys.length > 300, `expected the whole UI, found ${keys.length} keys`);
  const missing = keys.filter((key) => !translations.en[key]);
  assert.deepEqual(missing, [], `missing English for: ${missing.slice(0, 5).join(" | ")}`);
});

test("t() falls back to the source text instead of blanking out", () => {
  applyLocale("en", { persistLocally: false });
  assert.equal(t("已复制"), "Copied");
  assert.equal(t("这条没有翻译的文案"), "这条没有翻译的文案");
  assert.equal(t("已批准 {0} 条任务", [3]), "Approved 3 task(s)");
  applyLocale("zh", { persistLocally: false });
  assert.equal(t("已复制"), "已复制");
  assert.equal(t("已批准 {0} 条任务", [3]), "已批准 3 条任务");
});

test("the server resolves a locale from Accept-Language and normalises tags", () => {
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("en-GB"), "en");
  assert.equal(normalizeLocale("fr"), null);
  // q 值大的先赢,认不出来的跳过
  assert.equal(localeFromAcceptLanguage("fr;q=0.9,en-US;q=0.8,zh;q=0.2"), "en");
  assert.equal(localeFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh");
  assert.equal(localeFromAcceptLanguage("de"), null);
  assert.equal(localeFromAcceptLanguage(""), null);
});

test("server strings translate, and unknown keys stay readable", () => {
  assert.equal(
    translate("en", "工单状态由人来定：AI 只负责提"),
    "Ticket status is set by people; AIs only file them"
  );
  assert.equal(translate("zh", "工单状态由人来定：AI 只负责提"), "工单状态由人来定：AI 只负责提");
  assert.match(translate("en", "目标服务器无法访问：{0}", ["timeout"]), /^Target server unreachable: timeout$/);
  assert.equal(translate("en", "没翻过的字符串"), "没翻过的字符串");
});
