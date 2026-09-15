/* ============================================================
   每日一言与壁纸 · 交互逻辑
   壁纸接口：bimg.cc（一次返回 10 张，默认第一张，刷新随机一张）
   一言接口：60s API（随机一言）
   英文模式：金山词霸每日一句（open.iciba.com/dsapi），
            date 默认当天并记录 cookie，每次刷新后退一天，
            卡片双语展示（content 英文 + note 中文）
   壁纸刷新：双层背景层交替，0.8s crossfade 平滑换图
   ============================================================ */
(function () {
  "use strict";

  var WALLPAPER_API = "https://api.bimg.cc/all?page=";
  var WALLPAPER_PARAMS = "&order=asc&limit=10&w=1920&h=1080&mkt=zh-CN";
  var FALLBACK_WALLPAPER = "https://60s.viki.moe/v2/bing"; // 备选图源
  var POETRY_API = "/poetry/sentence"; // 诗词 API（nginx 反代）
  var POETRY_TOKEN = "RgU1rBKtLym/MhhYIXs42WNoqLyZeXY3EkAcDNrcfKkzj8ILIsAP1Hx0NGhdOO1I";
  var ICIBA_URL = "/iciba/?date="; // 英文模式：每日一句（nginx 同源反代，绕开上游无 CORS 头）
  var REQUEST_TIMEOUT = 12000;
  var IMAGE_TIMEOUT = 12000; // 单张图片预载超时（挂起请求不无限等待）

  var LANG_COOKIE = "site_lang";
  var ICIBA_DATE_COOKIE = "iciba_date";

  // 本地兜底文案：接口失败时保证页面依然体面
  var FALLBACK_LINES = [
    "生活明朗，万物可爱。",
    "慢慢来，比较快。",
    "愿你眼里有光，心中有海。",
    "凡是过往，皆为序章。",
    "保持热爱，奔赴山海。",
  ];

  // 英文模式兜底文案：中英成对，保证失败时也维持双语卡片
  var FALLBACK_QUOTES_EN = [
    { en: "The best way out is always through.", zh: "出路永远要靠自己走出去。" },
    { en: "Little by little, one travels far.", zh: "积跬步，方至千里。" },
    { en: "Whatever you do, do it well.", zh: "无论做什么，都要做好。" },
    { en: "What we think, we become.", zh: "心之所想，成就其人。" },
    { en: "Keep your face to the sunshine.", zh: "永远面向阳光。" },
  ];

  var bgLayers = [
    document.getElementById("bgLayerA"),
    document.getElementById("bgLayerB"),
  ];
  var loader = document.getElementById("loader");
  var hitokotoEl = document.getElementById("hitokoto");
  var refreshBtn = document.getElementById("refresh");
  var wallpaperBtn = document.getElementById("wallpaperRefresh");
  var langBtn = document.getElementById("langSwitch");
  var creditCopyright = document.getElementById("creditCopyright");
  var creditTitle = document.getElementById("creditTitle");
  var creditDesc = document.getElementById("creditDesc");

  var hitokotoLoading = false; // 一言请求互斥锁
  var wallpaperLoading = false; // 壁纸请求互斥锁
  var activeLayer = -1; // 当前可见的背景层索引
  var revealed = false; // 页面是否已放行（遮罩淡出 + 入场）
  var pendingHitokoto = null; // 壁纸就绪前暂存的一言文案（string 或 {en,zh}）

  var currentLang = getCookie(LANG_COOKIE) === "en" ? "en" : "zh"; // 语言偏好（cookie 持久化）
  var quoteToken = 0; // 文案请求代际号：语言切换后丢弃旧响应，防止串台

  var wallpaperList = []; // 接口返回的 10 张图（缓存，刷新时本地随机）
  var currentIndex = -1; // 当前展示的图在列表中的下标
  var wallpaperRetry = 0; // 首屏壁纸失败自动重试次数
  // page 参数：cookie 为空 → 默认当月第几天；cookie 有值 → 直接 +1（避免强制刷新看到重复壁纸）并写回
  var savedPage = parseInt(getCookie("wallpaper_page"), 10);
  var hasSaved = isFinite(savedPage) && savedPage > 0;
  var page = hasSaved ? savedPage + 1 : new Date().getDate();
  if (hasSaved) setCookie("wallpaper_page", page, 365);
  var refreshCount = 0; // 壁纸刷新累计次数（每满 10 次 page+1 换一批）

  var WALLPAPER_CACHE_KEY = "wallpaper_cache"; // 本地壁纸缓存 key

  /* ---------- 工具 ---------- */

  // Cookie 读写（用于持久化 page 进度）
  function getCookie(name) {
    var m = document.cookie.match(
      new RegExp("(?:^|;\\s*)" + name + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : "";
  }

  function setCookie(name, value, days) {
    var expires = "";
    if (days) {
      var d = new Date();
      d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
      expires = "; expires=" + d.toUTCString();
    }
    document.cookie =
      name + "=" + encodeURIComponent(value) + expires + "; path=/";
  }

  // 本地壁纸缓存：保存当天第一张壁纸，下次加载优先使用
  function saveWallpaperCache(info) {
    try {
      var today = fmtDate(new Date());
      localStorage.setItem(WALLPAPER_CACHE_KEY, JSON.stringify({
        date: today,
        cover: info.cover,
        title: info.title || "",
        description: info.description || "",
        copyright: info.copyright || ""
      }));
    } catch (e) {}
  }

  function getWallpaperCache() {
    try {
      var raw = localStorage.getItem(WALLPAPER_CACHE_KEY);
      if (!raw) return null;
      var cache = JSON.parse(raw);
      var today = fmtDate(new Date());
      if (cache.date !== today) return null; // 只用当天缓存
      return cache;
    } catch (e) {
      return null;
    }
  }

  // 英文模式日期：cookie 有值 → 后退一天；无值 → 默认当天；
  // 每次取用都写回 cookie，实现「刷新一次，后退一天」
  function nextICIBADate() {
    var saved = getCookie(ICIBA_DATE_COOKIE);
    var d = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(saved)) {
      var p = saved.split("-");
      d = new Date(+p[0], +p[1] - 1, +p[2]);
      d.setDate(d.getDate() - 1);
    }
    var str = fmtDate(d || new Date());
    setCookie(ICIBA_DATE_COOKIE, str, 365);
    return str;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function fmtDate(d) {
    return (
      d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
    );
  }

  // 无 fetch 时的 XHR 降级请求
  function httpGet(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = REQUEST_TIMEOUT;
      xhr.onload = function () {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error("bad json"));
        }
      };
      xhr.onerror = function () {
        reject(new Error("xhr error"));
      };
      xhr.ontimeout = function () {
        reject(new Error("xhr timeout"));
      };
      xhr.send();
    });
  }

  // 带超时的 JSON 请求（fetch 优先，不可用时降级 XHR；
  // 用 then 双参替代 finally，兼容不支持 finally 的旧浏览器）
  function fetchJSON(url, headers) {
    if (typeof fetch !== "function") {
      return httpGet(url);
    }
    var hasAbort = typeof AbortController !== "undefined";
    var controller = hasAbort ? new AbortController() : null;
    var timer = hasAbort
      ? setTimeout(function () {
          controller.abort();
        }, REQUEST_TIMEOUT)
      : null;

    var fetchHeaders = { Accept: "application/json" };
    if (headers) {
      for (var key in headers) {
        fetchHeaders[key] = headers[key];
      }
    }

    return fetch(url, {
      signal: hasAbort ? controller.signal : undefined,
      headers: fetchHeaders,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(
        function (val) {
          if (timer) clearTimeout(timer);
          return val;
        },
        function (err) {
          if (timer) clearTimeout(timer);
          throw err;
        }
      );
  }

  // 多源竞速预载：同时加载多个候选图，谁先加载完成用谁；
  // 每张图带超时——挂起的请求不会无限等待，超时视为失败
  function preloadFirstAvailable(sources) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var pending = sources.length;
      sources.forEach(function (src) {
        var img = new Image();
        var timer = setTimeout(function () {
          img.onload = null; // 超时后不再监听，避免重复计数
          img.onerror = null;
          pending -= 1;
          if (pending <= 0 && !done) {
            reject(new Error("image timeout"));
          }
        }, IMAGE_TIMEOUT);
        img.onload = function () {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(src);
          }
        };
        img.onerror = function () {
          clearTimeout(timer);
          pending -= 1;
          if (pending <= 0 && !done) {
            reject(new Error("image load failed"));
          }
        };
        img.src = src;
      });
    });
  }

  /* ---------- 背景层：bimg.cc 壁纸（10 张，默认第一张 / 刷新随机） ---------- */

  /* ---------- 进入流程：壁纸就绪后放行 ---------- */

  function reveal() {
    if (revealed) return;
    revealed = true;
    // 先让背景淡入过渡启动，再揭幕
    setTimeout(function () {
      loader.classList.add("hidden");
      document.body.classList.add("ready");
      // 展示等待中的一言（直接写入，入场动画已覆盖视觉过渡）
      if (pendingHitokoto) {
        renderQuote(pendingHitokoto);
        pendingHitokoto = null;
      }
    }, 250);
  }

  function applyWallpaper(info, first) {
    var target = bgLayers[(activeLayer + 1) % 2];
    var prev = activeLayer >= 0 ? bgLayers[activeLayer] : null;

    target.style.backgroundImage = 'url("' + info.cover + '")';
    target.classList.add("active");
    if (first) target.classList.add("enter"); // 首次：模糊 → 清晰揭示
    if (prev) prev.classList.remove("active");
    activeLayer = (activeLayer + 1) % 2;

    // 角标信息同步更新（新接口无背后故事字段，仅标题 + 版权）
    creditCopyright.textContent = info.copyright || "每日一言 · 壁纸";
    creditTitle.textContent = info.title || "";
    creditDesc.textContent = info.description || "";
  }

  // 顺序预载尝试：从 fromIndex 开始逐张尝试，全部失败才 reject
  function tryPreload(images, fromIndex) {
    return preloadFirstAvailable([images[fromIndex].cover])
      .then(function () {
        return images[fromIndex];
      })
      .catch(function () {
        if (fromIndex + 1 < images.length) {
          return tryPreload(images, fromIndex + 1);
        }
        throw new Error("all images failed");
      });
  }

  // 请求当前 page 并缓存列表（空结果自动回退到当天重试一次，避免 page 越界黑屏）
  function fetchWallpaperList(resetOnEmpty) {
    return fetchJSON(WALLPAPER_API + page + WALLPAPER_PARAMS).then(function (
      json
    ) {
      var list = (json && json.data) || [];
      var images = list
        .filter(function (item) {
          return item && item.url;
        })
        .map(function (item) {
          return {
            cover: item.url,
            title: item.title || "",
            description: "",
            copyright: item.copyright || "",
          };
        });
      if (!images.length) {
        if (resetOnEmpty) {
          page = new Date().getDate();
          setCookie("wallpaper_page", page, 365);
          return fetchWallpaperList(false);
        }
        throw new Error("no images");
      }
      wallpaperList = images;
      return images;
    });
  }

  // 备选图源：60s API 必应壁纸（bimg.cc 失败时兜底，双源提高出图率）
  function loadFallbackWallpaper() {
    return fetchJSON(FALLBACK_WALLPAPER)
      .then(function (json) {
        var data = (json && json.data) || {};
        var cover = data.cover_4k || data.cover;
        if (!cover) throw new Error("no fallback cover");
        return preloadFirstAvailable([cover]).then(function () {
          return {
            cover: cover,
            title: data.title || "",
            description: data.description || "",
            copyright: data.copyright || "",
          };
        });
      });
  }

  // 首屏：请求接口 → 缓存 10 张 → 默认展示第一张（失败自动顺延下一张）
  function loadWallpaper() {
    if (wallpaperLoading) return;
    wallpaperLoading = true;
    wallpaperBtn.classList.add("loading");

    // 优先使用当天缓存的壁纸（秒开体验）
    var cached = getWallpaperCache();
    if (cached && cached.cover) {
      preloadFirstAvailable([cached.cover])
        .then(function () {
          applyWallpaper(cached, !revealed);
          reveal();
        })
        .catch(function () {
          // 缓存加载失败，继续从 API 加载
          loadWallpaperFromAPI(true);
          return;
        })
        .then(function () {
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
        });
      // 同时从 API 加载壁纸列表（供刷新使用），但不改变当前展示
      fetchWallpaperList(true).catch(function () {});
      return;
    }

    loadWallpaperFromAPI(true);
  }

  // 从 API 加载壁纸（showFirst=1 展示第一张，0 仅加载列表）
  function loadWallpaperFromAPI(showFirst) {
    fetchWallpaperList(true)
      .then(function (images) {
        if (!showFirst) {
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
          return;
        }
        return tryPreload(images, 0).then(function (info) {
          currentIndex = wallpaperList.indexOf(info);
          applyWallpaper(info, !revealed);
          saveWallpaperCache(info);
          reveal();
        });
      })
      .catch(function () {
        if (!showFirst) return;
        if (activeLayer < 0) {
          loadFallbackWallpaper()
            .then(function (info) {
              applyWallpaper(info, !revealed);
              saveWallpaperCache(info);
              reveal();
            })
            .catch(function () {
              creditCopyright.textContent = "壁纸加载失败 · 每日一言";
              creditTitle.textContent = "";
              creditDesc.textContent = "";
              if (wallpaperRetry < 3) {
                wallpaperRetry += 1;
                setTimeout(loadWallpaper, 8000);
              }
              reveal();
            });
        } else {
          reveal();
        }
      })
      .then(
        function (val) {
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
          return val;
        },
        function (err) {
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
          throw err;
        }
      );
  }

  // 随机下标（避开当前展示的图；限次重抽，杜绝极端死循环）
  function pickIndex() {
    var n = wallpaperList.length;
    if (n <= 1) return 0;
    var idx = 0;
    for (var t = 0; t < 5; t++) {
      idx = Math.floor(Math.random() * n);
      if (idx !== currentIndex) break;
    }
    return idx;
  }

  // 刷新：本地随机一张；每满 10 次刷新 page+1，拉取新一批再随机；
  // 每满 5 次刷新联动换一句新文字（cookie 计数持久化）
  function refreshWallpaper() {
    if (wallpaperLoading) return;
    refreshCount += 1;

    // 每点击 5 次壁纸刷新 → 自动换一句新文字
    var textCount = parseInt(getCookie("hitokoto_wallpaper_count"), 10) || 0;
    textCount += 1;
    setCookie("hitokoto_wallpaper_count", textCount, 365);
    if (textCount % 5 === 0) loadQuote();

    // 列表未就绪：从 API 获取新壁纸并更新缓存
    if (!wallpaperList.length) {
      wallpaperLoading = true;
      wallpaperBtn.classList.add("loading");
      fetchWallpaperList(true)
        .then(function (images) {
          var idx = pickIndex();
          return preloadFirstAvailable([images[idx].cover]).then(function () {
            return idx;
          });
        })
        .then(function (idx) {
          currentIndex = idx;
          applyWallpaper(wallpaperList[idx], false);
          saveWallpaperCache(wallpaperList[idx]); // 更新缓存
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
        })
        .catch(function () {
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
        });
      return;
    }

    // 每满 10 次刷新：page+1，拉取新一批，随机一张展示
    if (refreshCount % 10 === 0) {
      page += 1;
      setCookie("wallpaper_page", page, 365); // page 变化时写回 cookie
      wallpaperLoading = true;
      wallpaperBtn.classList.add("loading");
      fetchWallpaperList(true)
        .then(function (images) {
          var idx = pickIndex();
          return preloadFirstAvailable([images[idx].cover]).then(function () {
            return idx;
          });
        })
        .then(function (idx) {
          currentIndex = idx;
          applyWallpaper(wallpaperList[idx], false);
          saveWallpaperCache(wallpaperList[idx]); // 保存刷新后的壁纸到缓存
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
        })
        .catch(function () {
          // 拉新失败：静默保留旧图（新列表已缓存，下次刷新本地随机）
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
        });
      return;
    }

    // 本地随机（最多换 3 次避免全挂）
    wallpaperLoading = true;
    wallpaperBtn.classList.add("loading");

    var attempt = 0;
    function next() {
      attempt += 1;
      var idx = pickIndex();
      var info = wallpaperList[idx];
      preloadFirstAvailable([info.cover])
        .then(function () {
          currentIndex = idx;
          applyWallpaper(info, false);
          saveWallpaperCache(info); // 保存刷新后的壁纸到缓存
          wallpaperLoading = false;
          wallpaperBtn.classList.remove("loading");
        })
        .catch(function () {
          if (attempt < 3) {
            next();
          } else {
            wallpaperLoading = false;
            wallpaperBtn.classList.remove("loading"); // 静默保留旧图
          }
        });
    }
    next();
  }

  /* ---------- 内容层：中文随机一言 / 英文每日一句 ---------- */

  // 按语言分发：英文走 iciba 每日一句，否则随机一言
  function loadQuote() {
    quoteToken += 1;
    if (currentLang === "en") {
      loadDailyEnglish(quoteToken);
    } else {
      loadHitokoto(quoteToken);
    }
  }

  // 立即请求一句新文字（按钮 / 双击 / 壁纸联动触发）
  function loadHitokoto(token) {
    if (hitokotoLoading) return;
    hitokotoLoading = true;
    refreshBtn.classList.add("loading");

    fetchJSON(POETRY_API, { "X-User-Token": POETRY_TOKEN })
      .then(function (json) {
        if (token !== quoteToken) return;
        var data = json && json.data;
        var text = data && data.content;
        if (!text) throw new Error("empty poetry");
        // 返回结构化数据
        var origin = data.origin || {};
        deliverQuote({
          text: text,
          author: origin.author || "",
          title: origin.title || "",
          dynasty: origin.dynasty || ""
        });
      })
      .catch(function () {
        if (token !== quoteToken) return;
        var fallback =
          FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)];
        deliverQuote(fallback);
      })
      .then(
        function (val) {
          hitokotoLoading = false;
          refreshBtn.classList.remove("loading");
          return val;
        },
        function (err) {
          hitokotoLoading = false;
          refreshBtn.classList.remove("loading");
          throw err;
        }
      );
  }

  // 英文模式：金山词霸每日一句，date 每次刷新后退一天（cookie 记录），
  // 卡片双语展示 —— content 英文主句 + note 中文译文
  function loadDailyEnglish(token) {
    if (hitokotoLoading) return;
    hitokotoLoading = true;
    refreshBtn.classList.add("loading");

    var date = nextICIBADate();

    fetchJSON(ICIBA_URL + date)
      .then(function (json) {
        if (token !== quoteToken) return;
        var en = json && json.content;
        var zh = json && json.note;
        if (!en || !zh) throw new Error("empty daily sentence");
        deliverQuote({ en: en, zh: zh });
      })
      .catch(function () {
        if (token !== quoteToken) return;
        var fb =
          FALLBACK_QUOTES_EN[
            Math.floor(Math.random() * FALLBACK_QUOTES_EN.length)
          ];
        deliverQuote({ en: fb.en, zh: fb.zh });
      })
      .then(
        function (val) {
          hitokotoLoading = false;
          refreshBtn.classList.remove("loading");
          return val;
        },
        function (err) {
          hitokotoLoading = false;
          refreshBtn.classList.remove("loading");
          throw err;
        }
      );
  }

  // 文案就绪后的投放：壁纸未就绪先暂存，入场时一起展示
  function deliverQuote(quote) {
    if (revealed) {
      renderQuote(quote);
    } else {
      pendingHitokoto = quote;
    }
  }

  function renderQuote(quote) {
    // 先淡出再切换：通过强制回流重新触发 fadeUp 动画
    hitokotoEl.classList.remove("pop");
    if (quote && typeof quote === "object") {
      hitokotoEl.textContent = "";
      // 英文模式：双语卡片
      if (quote.en) {
        var enSpan = document.createElement("span");
        enSpan.className = "quote-en";
        enSpan.textContent = quote.en || "";
        hitokotoEl.appendChild(enSpan);
        if (quote.zh) {
          var zhSpan = document.createElement("span");
          zhSpan.className = "quote-zh";
          zhSpan.textContent = quote.zh;
          hitokotoEl.appendChild(zhSpan);
        }
      }
      // 诗词模式：内容 + 作者信息
      else if (quote.text) {
        var textSpan = document.createElement("span");
        textSpan.className = "quote-text";
        textSpan.textContent = quote.text;
        hitokotoEl.appendChild(textSpan);
        if (quote.dynasty || quote.author) {
          var infoSpan = document.createElement("span");
          infoSpan.className = "quote-info";
          var info = "";
          if (quote.dynasty) info += quote.dynasty + "·";
          if (quote.author) info += quote.author;
          if (quote.title) info += "《" + quote.title + "》";
          infoSpan.textContent = info;
          hitokotoEl.appendChild(infoSpan);
        }
      }
    } else {
      hitokotoEl.textContent = quote;
    }
    void hitokotoEl.offsetWidth; // 强制回流，确保动画重新播放
    hitokotoEl.classList.add("pop");
  }

  /* ---------- 语言切换 ---------- */

  function updateLangButton() {
    if (!langBtn) return;
    langBtn.textContent = currentLang === "en" ? "中" : "EN";
    var tip = currentLang === "en" ? "切换到中文" : "切换到英文";
    langBtn.setAttribute("aria-label", tip);
    langBtn.setAttribute("title", tip);
  }

  /* ---------- 交互 ---------- */

  // 粒子按钮：刷新一言（英文模式下后退一天取上一日句子）
  refreshBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    loadQuote();
  });

  // 右上角胶囊按钮：中 / 英切换（偏好写入 cookie，立即按语言重新拉取文案）
  if (langBtn) {
    langBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      currentLang = currentLang === "en" ? "zh" : "en";
      setCookie(LANG_COOKIE, currentLang, 365);
      document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
      updateLangButton();
      hitokotoLoading = false; // 允许打断进行中的请求，立即响应切换
      loadQuote();
    });
  }

  // 右下角微光按钮：刷新壁纸（本地随机一张）
  wallpaperBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    refreshWallpaper();
  });

  // 双击屏幕空白处（卡片、角标与语言按钮之外）刷新一言
  document.addEventListener("dblclick", function (e) {
    if (
      e.target.closest(".card") ||
      e.target.closest(".credit") ||
      e.target.closest(".lang-switch")
    )
      return;
    loadQuote();
    // 清理双击产生的文本选区
    if (window.getSelection && window.getSelection().removeAllRanges) {
      window.getSelection().removeAllRanges();
    }
  });

  /* ---------- 启动 ---------- */
  // 结构守卫：关键元素缺失时不崩溃，直接放行避免黑屏
  var required = bgLayers.concat([
    loader,
    hitokotoEl,
    refreshBtn,
    wallpaperBtn,
  ]);
  var missing = required.some(function (el) {
    return !el;
  });
  if (missing) {
    if (loader) loader.classList.add("hidden");
    document.body.classList.add("ready");
    return;
  }

  updateLangButton();
  if (currentLang === "en") document.documentElement.lang = "en";

  loadWallpaper();
  loadQuote();
  // 兜底：壁纸长时间未就绪也放行（6 秒），绝不卡在遮罩；
  // 启动区捕获任何同步异常，保证页面不会停在加载遮罩
  setTimeout(function () {
    try {
      reveal();
    } catch (e) {
      if (loader) loader.classList.add("hidden");
      document.body.classList.add("ready");
    }
  }, 6000);
})();
