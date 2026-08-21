// 网页端每打开一次群组就是一次完整页面加载:HTML 一趟、js/css 一趟。隧道一次往返
// 0.5-1.8 秒,所以桌面客户端(窗口一直开着,不重新加载)秒开,网页端却要盯着转圈等。
// 这里改成先用缓存、再后台校验:界面立刻画出来,新版本在后台发现并提示刷新。
// cacheName 每次发版都要跟着升,activate 时会删掉所有旧名字的缓存。
const cacheName = "group-relay-shell-v37";
const shell = ["/app", "/style.css", "/app.js", "/i18n.js", "/markdown.js", "/history.js", "/manifest.json", "/icon-180.png", "/icon-512.png"];

// 导航请求(地址栏、/group/xxx)统统回这一份 HTML —— 路由是前端做的。
const shellDocument = "/app";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    // 逐个放,不用 addAll:隧道抖一下少一个文件的话,addAll 会整批失败,
    // 于是 SW 永远装不上,每次加载都重试一遍。
    await Promise.allSettled(shell.map((path) => cache.add(new Request(path, { cache: "reload" }))));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

async function announceUpdate() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "shell-updated" });
}

/// 后台校验:拿到新的就写进缓存,并且只在内容真的变了时提示页面。ETag 由 express.static
/// 给出,变了就说明这个文件确实是新的。
async function revalidate(request, cached) {
  try {
    const response = await fetch(request, { cache: "no-cache" });
    if (!response.ok) return;
    const changed = !cached || cached.headers.get("etag") !== response.headers.get("etag");
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    if (changed && cached) await announceUpdate();
  } catch {
    // 离线或者隧道抖:缓存里那份继续用,下次加载再校验。
  }
}

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== location.origin || requestUrl.pathname.startsWith("/api/")) {
    return;
  }
  const isNavigation = event.request.mode === "navigate";
  const key = isNavigation ? shellDocument : event.request;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(key);
    if (cached) {
      // 立刻用缓存那份画界面,同时后台去看有没有新版本。
      event.waitUntil(revalidate(new Request(key, { cache: "no-cache" }), cached));
      return cached;
    }
    // 缓存里没有(第一次访问、或者刚清过):只能等网络,顺便存下来。
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(key, response.clone());
      return response;
    } catch (error) {
      const fallback = await cache.match(shellDocument);
      if (isNavigation && fallback) return fallback;
      throw error;
    }
  })());
});
