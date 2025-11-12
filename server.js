// server.js
const express = require("express");
const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const rateLimit = require("express-rate-limit");
const pLimit = require("p-limit").default;
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;
const browserLimit = pLimit(1); // Freeプラン用に1に削減

app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.use(express.static(path.join(__dirname, "public")));

function isBlockedUrl(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname;
    if (/^(localhost|127\.0\.0\.1|::1)$/.test(host)) return true;
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1]))/.test(host)) return true;
    if (host.endsWith(".local")) return true;
    return false;
  } catch {
    return true;
  }
}

app.get("/fetch", async (req, res) => {
  const target = req.query.url;
  console.log("[/fetch] request:", target, "from", req.ip);
  if (!target) return res.status(400).send("url required");
  if (isBlockedUrl(target)) return res.status(403).send("forbidden");

  try {
    const { content: html, finalUrl } = await browserLimit(async () => {
      const browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-extensions"
        ],
      });
      let page;
      try {
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        console.log("[/fetch] navigating to:", target);
        try {
          await page.goto(target, { waitUntil: "networkidle2", timeout: 30000 });
        } catch (err) {
          console.error("[/fetch] page.goto error:", err && err.message);
          throw new Error("page.goto failed: " + (err && err.message));
        }

        const finalResolved = page.url();
        console.log("[/fetch] finalResolved:", finalResolved);
        if (isBlockedUrl(finalResolved)) {
          console.warn("[/fetch] blocked finalResolved:", finalResolved);
          throw new Error("resolved url is forbidden");
        }

        const content = await page.content();
        return { content, finalUrl: finalResolved };
      } finally {
        try { if (browser) await browser.close(); } catch (e) { console.error("browser close error", e && e.message); }
      }
    });

    const $ = cheerio.load(html, { decodeEntities: false });

    // Remove manifest / service-worker related links/meta
    $('link[rel="manifest"]').remove();
    $('meta[name="service-worker"]').remove();
    $('meta[name="sw"]').remove();

    // Remove all scripts to avoid client-side service worker registration and third-party runtime errors.
    // We'll inject only our own small click-interceptor script below.
    $('script').remove();

    // Rewrite resource URLs (images, links, forms, iframes, etc.) to absolute using finalUrl base
    const attrs = [
      { sel: "img", attr: "src" },
      { sel: "link", attr: "href" },
      { sel: "a", attr: "href" },
      { sel: "form", attr: "action" },
      { sel: "iframe", attr: "src" },
      { sel: "video", attr: "src" },
      { sel: "source", attr: "src" },
    ];
    attrs.forEach(({ sel, attr }) => {
      $(sel).each((_, el) => {
        const val = $(el).attr(attr);
        if (!val) return;
        try {
          const abs = new URL(val, finalUrl).toString();
          // For iframes and anchors make them go through our proxy
          if (sel === "a") {
            const proxyHref = `${req.protocol}://${req.get("host")}/fetch?url=${encodeURIComponent(abs)}`;
            $(el).attr("data-original-url", abs);
            $(el).attr("href", proxyHref);
          } else if (sel === "iframe") {
            $(el).attr(attr, `${req.protocol}://${req.get("host")}/fetch?url=${encodeURIComponent(abs)}`);
          } else {
            $(el).attr(attr, abs);
          }
        } catch (e) {
          // ignore malformed URLs
        }
      });
    });

    // Inject only one safe script: click interceptor + UI helper
    const INJECTED_SCRIPT = `
      <script data-proxy-injected>
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
                try { window.top.location.href = a.href; } catch (err) {}
              }, 250);
            }
          } catch (err) {
            console && console.warn && console.warn('[proxy] click handler error', err);
          }
        }, true);
      })();
      </script>
    `;
    $("body").append(INJECTED_SCRIPT);

    // Set base to final resolved URL so relative hrefs resolve on client for non-processed resources
    $("head").prepend(`<base href="${finalUrl}">`);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send($.html());
  } catch (err) {
    console.error("[/fetch] fetch/render error:", err && err.message);
    if (err.message && err.message.includes("resolved url is forbidden")) {
      return res.status(403).send("Forbidden: resolved url blocked");
    }
    res.status(502).send("Failed to render page: " + (err && err.message));
  }
});

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} port:${PORT}`);
});
