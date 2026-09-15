# AGENTS.md

## 全局规则

- 所有回答以【Jerry:】开头
- 使用中文简体回答问题

## Project Overview

Static Chinese-language site (code.i-xx.top) displaying daily quotes and wallpapers. Pure vanilla HTML/CSS/JS — no build tools, no frameworks, no package manager.

## Structure

- `index.html` — entry point (currently a placeholder page, not the main app)
- `script.js` — main application logic (daily quotes, wallpaper loading, language switching)
- `style.css` — full styling with animations, responsive design
- `git.md` — PRD for a different project (Mini Git Web), not related to this site

## Key Technical Details

### External APIs
- Wallpaper: `api.bimg.cc` (primary), `60s.viki.moe` (fallback)
- Chinese quotes: `/poetry/sentence` (nginx reverse proxy, requires `X-User-Token` header)
- English quotes: `/iciba/` (nginx reverse proxy,金山词霸 daily sentence)

### State Management
- `localStorage`: wallpaper cache (`wallpaper_cache`), used for same-day fast reload
- Cookies: language preference (`site_lang`), wallpaper page progress (`wallpaper_page`), iciba date (`iciba_date`), hitokoto refresh count (`hitokoto_wallpaper_count`)

### Important Patterns
- Dual-layer background for crossfade transitions (`bgLayerA`/`bgLayerB`)
- 6-second reveal timeout — page never hangs on loading screen
- Request timeout: 12s for API calls, 12s for image preloading
- XHR fallback when `fetch` is unavailable
- English mode uses date-rewinding logic (each refresh goes back one day)

## No Build/Test Commands

This is a static site with no build process. Deploy by copying files to web server root.

---

## stocks.i-xx.top 项目规则

当任务涉及修改 `stocks.i-xx.top` 项目的任何功能时，**必须先读取功能文档**：

```
/www/wwwroot/stocks.i-xx.top/FUNCTIONS.md
```

该文档包含：
- 全部 18 个页面功能与文件映射
- 前端 Vue 组件、路由、Store 对应关系
- 后端 API 路由模块与 Celery 异步任务
- 全局共享组件用途说明
- 修改功能时的重要约定（新建页面、新增 API、异步任务、构建命令等）

修改 stocks 项目时跳过此步骤可能导致：改错文件、遗漏关联组件、破坏构建流程。
