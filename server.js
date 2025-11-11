// server.js
const express = require("express");
const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const rateLimit = require("express-rate-limit");
const pLimit = require("p-limit").default;
const path = require("path");
const { URL } = require("url");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// concurrency limit for headless sessions
const browserLimit = pLimit(3);

// simple rate limit
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// serve static files
app.use(express.static(path.join(__dirname, "public")));

// SSRF protection
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

// --- /fetch?url=SHORT_OR_FULL_URL ---
app.get("/fetch", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("url required");
  if (isBlockedUrl(target)) return res.status(403).send("forbidden");

  try {
    // browserLimit returns both content and the final resolved URL
    const { content: html, finalUrl } = await browserLimit(async () => {
      const browser = await puppeteer.launch({
  executablePath: '/opt/render/.cache/puppeteer/chrome/linux-<version>/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
      let page;
      try {
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(target, { waitUntil: "networkidle2", timeout: 30000 });

        // get final resolved URL after redirects
        const finalResolved = page.url();

        // Additional SSRF protection: if the final resolved URL points to blocked host, abort.
        if (isBlockedUrl(finalResolved)) {
          throw new Error("resolved url is forbidden");
        }

        const content = await page.content();
        return { content, finalUrl: finalResolved };
      } finally {
        try {
          if (browser) await browser.close();
        } catch (err) {
          // ignore close errors
        }
      }
    });

    const $ = cheerio.load(html, { decodeEntities: false });

    // rewrite resource URLs using finalUrl as the base so relative links are resolved
    // against the actual loaded page (after redirects), not the original query param.
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

    // replace <a> for client interception
    // Use finalUrl as base so data-original-url is the real absolute link
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || href === "#" || href.startsWith("javascript:")) return;
      try {
        const abs = new URL(href, finalUrl).toString();
        // build an absolute URL pointing to our proxy /fetch route so
        // clicks (and middle-click/new-tab) will go through the proxy
        const proxyHref = `${req.protocol}://${req.get("host")}/fetch?url=${encodeURIComponent(
          abs
        )}`;
        $(el).attr("data-original-url", abs);
        $(el).attr("href", proxyHref);
      } catch {}
    });

    // remove trackers
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

    // --- Inject click interceptor ---
    const INJECTED_SCRIPT = `
      <script>
      (function(){
        // Only intercept clicks when inside an iframe and notify the parent.
        // For top-level browsing contexts we rely on the anchor href which
        // we already rewrote to point to the proxy. This avoids breaking
        // navigation when postMessage handling is absent.
        document.addEventListener('click', function(e){
          try {
            const a = e.target.closest && e.target.closest('a');
            if (!a) return;
            const originalUrl = a.getAttribute('data-original-url');
            if (!originalUrl) return;
            if (window.parent && window.parent !== window) {
              // inside an iframe: notify parent and prevent default navigation
              e.preventDefault();
              e.stopPropagation();
              a.style.opacity = '0.6';
              window.parent.postMessage({ type: 'proxy-navigate', url: originalUrl }, '*');
              // If the parent does not handle the message, attempt a safe
              // fallback after a short delay to navigate the top window to
              // the proxy URL (which is set as the anchor href). This should
              // trigger top-level navigation in most browsers.
              setTimeout(function(){
                try {
                  // a.href was rewritten on the server to point to our proxy
                  window.top.location.href = a.href;
                } catch (err) {
                  // ignore; cross-origin assignment may throw in some contexts
                }
              }, 250);
            }
            // otherwise do nothing and let the browser follow the href which
            // points to our proxy /fetch route as a fallback.
          } catch (err) {
            // swallow errors to avoid breaking page scripts
            console && console.warn && console.warn('[proxy] click handler error', err);
          }
        }, true);
      })();
      </script>
    `;
    $("body").append(INJECTED_SCRIPT);

    // Set base to the final resolved URL (so relative resources resolve correctly on the client)
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
  console.log(`Pseudo-browser server listening on http://localhost:${PORT}`);
});

