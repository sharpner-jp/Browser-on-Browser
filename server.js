// server.js
const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const cheerio = require("cheerio");
const rateLimit = require("express-rate-limit");
const pLimit = require("p-limit").default;
const path = require("path");
const { URL } = require("url");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// 同時実行制限
const browserLimit = pLimit(3);

// レート制限
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// public フォルダ配信
app.use(express.static(path.join(__dirname, "public")));

// SSRF防止
function isBlockedUrl(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname;
    if (/^(localhost|127\.0\.0\.1|::1)$/.test(host)) return true;
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1]))/.test(host))
      return true;
    if (host.endsWith(".local")) return true;
    return false;
  } catch {
    return true;
  }
}

// Puppeteerブラウザインスタンスをキャッシュ（Renderでは再利用したほうが高速）
let browser;
async function getBrowser() {
  if (browser) return browser;
  const executablePath = await chromium.executablePath();
  browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });
  console.log("✅ Puppeteer browser launched");
  return browser;
}

// /fetchエンドポイント
app.get("/fetch", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("url required");
  if (isBlockedUrl(target)) return res.status(403).send("forbidden");

  try {
    const { content: html, finalUrl } = await browserLimit(async () => {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(target, { waitUntil: "networkidle2", timeout: 30000 });
        const finalResolved = page.url();
        if (isBlockedUrl(finalResolved)) throw new Error("resolved url is forbidden");
        const content = await page.content();
        await page.close();
        return { content, finalUrl: finalResolved };
      } catch (err) {
        await page.close();
        throw err;
      }
    });

    const $ = cheerio.load(html, { decodeEntities: false });

    // URL絶対化
    const attrs = [
      { sel: "img", attr: "src" },
      { sel: "link", attr: "href" },
      { sel: "script", attr: "src" },
      { sel: "a", attr: "href" },
      { sel: "form", attr: "action" },
      { sel: "iframe", attr: "src" },
    ];
    attrs.forEach(({ sel, attr }) => {
      $(sel).each((_, el) => {
        const val = $(el).attr(attr);
        if (!val) return;
        try {
          const abs = new URL(val, finalUrl).toString();
          $(el).attr(attr, abs);
        } catch {}
      });
    });

    // <a>タグの変換
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || href === "#" || href.startsWith("javascript:")) return;
      try {
        const abs = new URL(href, finalUrl).toString();
        const proxyHref = `${req.protocol}://${req.get("host")}/fetch?url=${encodeURIComponent(abs)}`;
        $(el).attr("data-original-url", abs);
        $(el).attr("href", proxyHref);
      } catch {}
    });

    // 追跡スクリプト除去
    $("script").each((_, el) => {
      const src = $(el).attr("src") || "";
      const inner = $(el).html() || "";
      if (
        src.includes("googletagmanager") ||
        src.includes("google-analytics") ||
        /analytics|ads|gtag|doubleclick/.test(src + inner)
      ) {
        $(el).remove();
      }
    });

    // クリックイベント注入
    const INJECTED_SCRIPT = `
      <script>
      (function(){
        document.addEventListener('click', function(e){
          try {
            const a = e.target.closest && e.target.closest('a');
            if (!a) return;
            const originalUrl = a.getAttribute('data-original-url');
            if (!originalUrl) return;
            if (window.parent && window.parent !== window) {
              e.preventDefault();
              e.stopPropagation();
              a.style.opacity = '0.6';
              window.parent.postMessage({ type: 'proxy-navigate', url: originalUrl }, '*');
              setTimeout(function(){
                try { window.top.location.href = a.href; } catch {}
              }, 250);
            }
          } catch (err) {
            console && console.warn && console.warn('[proxy click error]', err);
          }
        }, true);
      })();
      </script>
    `;
    $("body").append(INJECTED_SCRIPT);

    // baseタグ設定
    $("head").prepend(`<base href="${finalUrl}">`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send($.html());
  } catch (err) {
    console.error("fetch/render error:", err);
    if (err.message === "resolved url is forbidden") {
      return res.status(403).send("Forbidden: resolved url blocked");
    }
    res.status(502).send("Failed to render page: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Pseudo-browser server listening on http://localhost:${PORT}`);
});
