// ============================================================
// 持久静态客户端插件：右侧「对话密度地图」
// 纯 DOM、低侵入：不改聊天渲染/流式/消息结构/模型请求，只做展示层增强。
//
// 消息识别（复用页面现有 DOM）：
//   - 滚动视口   : [data-conversation-scroll]（会话 scrollBody，唯一滚动容器）
//   - 消息列     : [data-chat-flow]（聊天列）
//   - 单条消息行 : [data-chat-anchor-key]（每条消息/节点一行）
//   - 消息种类   : [data-chat-flow-kind] —— user=用户消息，assistant-step=AI 回复文本步，
//                                        tool-call=AI 的工具操作节点
//
// 显示口径（「只显示每次大对话」）：
//   每一条用户消息 = 一个用户标签；随后的 assistant-step / tool-call 全部并入
//   同一个「AI 大对话」标签（不被工具操作/多段文本切碎），最终形成
//   用户 → AI → 用户 → AI … 的简洁交替。
//   其余节点（steering/context/command/compaction/turn-tail 等）不计入标签，
//   也不打断对话分组。
//
// 长短计算：
//   - 用户标签：取该消息行自身高度
//   - AI 大对话：取整段对话的跨距（首行顶 → 末行底，含工具卡片），sqrt 归一化映射为
//     横线长度（只求「大致」，不追求像素精确）
//   刻度纵向位置 = 对应消息中心占全文高度的比例，形成真正的「对话密度地图」。
//   非最大化窗口：所有刻度一律最短（避免小窗内长短混杂干扰）；仅最大化窗口
//   才显示「长度反映消息长短」的密度差异（连当前/悬停的加长也一并取消，
//   当前节点仅靠亮度高亮识别）。位置/点击跳转均不受影响。
//
// 当前位置：IntersectionObserver（把视口裁成 30%~45% 的「阅读带」，rootMargin 实现），
//          只在消息跨带时回调更新，不逐帧遍历、不 setInterval 轮询。
//
// 动态新增：MutationObserver(子节点) 增量感知新消息 + ResizeObserver(消息列/视口) 感知
//          高度明显变化，统一 120ms 防抖重建；流式输出期间不会高频全量刷新。
//
// 性能护栏：重建仅读一次布局；文本只在跨度变化 >12% 或首次出现时重读。
// 主题：刻度用 --dsw-alias-label-tertiary / --dsw-alias-label-primary，深浅主题自动跟随。
// ============================================================
window.__ModuleLoader__.load({
  id: "dsh-conversation-density-map",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ===== 可调参数 =====
    var USER_KIND = "user";                              // 用户消息种类
    var AI_MEMBER_KINDS = { "assistant-step": true, "tool-call": true }; // 并入「AI 大对话」的行
    var BASE_W = 8;        // 最短横线（px）
    var MAX_W = 44;        // 最长横线（px）
    var REF_H = 1400;      // 高度参考：>= 此高度的内容视为「超长」（代码/长回答）
    var REBUILD_MS = 120;  // 重建防抖间隔
    var THRESH = 0.12;     // 高度变化比例阈值（超过才重读文本）
    var BAND_TOP = 0.30;   // 阅读带顶部（视口高度比例）
    var BAND_HEIGHT = 0.15; // 阅读带高度（视口高度比例）

    // 是否最大化窗口：用窗口外宽是否占满屏幕宽度近似（占满即最大化/全屏）。
    // 非最大化时右侧刻度一律最短，不体现长度差异（避免小窗内长短混杂干扰），
    // 仅最大化窗口才显示「长度反映消息长短」的密度差异。
    function isMaximized() {
      try {
        return typeof window !== "undefined" && window.outerWidth !== undefined &&
          window.screen && window.screen.width !== undefined &&
          window.outerWidth >= window.screen.width - 2;
      } catch (e) { return false; }
    }

    var state = {
      rail: null, tip: null, styleEl: null,
      scrollport: null, flow: null,
      msgs: [],                          // 当前标签顺序（tick 元素）
      tickByKey: Object.create(null),    // groupKey -> tick
      textCache: new Map(),              // groupKey -> { h0, len, first }
      rowGroup: new Map(),               // 行 anchor key -> groupKey（当前位置映射）
      currentKey: null, hot: false,
      maximized: false,                  // 当前窗口是否最大化（决定长度是否可变）
      io: null, mo: null, ro: null, bgMo: null,
      rebuildTimer: null, pendingFrame: false,
    };

    // ------------------------------------------------------------
    // 骨架（chrome）：rail + tooltip + 全局监听 + 后台挂载观察器
    // ------------------------------------------------------------
    function createChrome() {
      var rail = document.createElement("div");
      rail.className = "dsh-dmap";
      rail.setAttribute("role", "navigation");
      rail.setAttribute("aria-label", "对话密度地图");
      rail.style.display = "none";
      document.body.appendChild(rail);
      state.rail = rail;

      var tip = document.createElement("div");
      tip.className = "dsh-dmap-tip";
      document.body.appendChild(tip);
      state.tip = tip;

      rail.addEventListener("click", onClickTick);

      document.addEventListener("mousemove", onDocMove, { passive: true });
      window.addEventListener("resize", onWinResize);

      // 后台观察器：等待 / 跟踪 [data-conversation-scroll] 与 [data-chat-flow] 的出现与消失
      state.bgMo = new MutationObserver(function () { scheduleRebound(); });
      state.bgMo.observe(document.documentElement, {
        childList: true, subtree: true, characterData: false,
      });
    }

    function disposeChrome() {
      if (state.rail && state.rail.parentNode) state.rail.parentNode.removeChild(state.rail);
      if (state.tip && state.tip.parentNode) state.tip.parentNode.removeChild(state.tip);
      state.rail = null;
      state.tip = null;
      document.removeEventListener("mousemove", onDocMove);
      window.removeEventListener("resize", onWinResize);
      if (state.bgMo) { state.bgMo.disconnect(); state.bgMo = null; }
    }

    // ------------------------------------------------------------
    // 绑定 / 解绑一个会话的聊天视图
    // ------------------------------------------------------------
    function ensureBound() {
      var sp = document.querySelector("[data-conversation-scroll]");
      var flow = sp ? sp.querySelector("[data-chat-flow]") : null;
      if (flow && flow.isConnected && state.flow !== flow) bind(sp, flow);
      else if (state.flow !== null && (!flow || !flow.isConnected)) teardownView();
    }

    var reboundTimer = null;
    function scheduleRebound() {
      if (reboundTimer !== null) return;
      reboundTimer = setTimeout(function () {
        reboundTimer = null;
        ensureBound();
      }, 150);
    }

    function bind(scrollport, flow) {
      teardownView();
      state.scrollport = scrollport;
      state.flow = flow;
      state.textCache = new Map();
      state.rowGroup = new Map();
      state.currentKey = null;
      if (!state.rail) createChrome();
      state.rail.style.display = "";

      state.ro = new ResizeObserver(function () {
        anchor();          // 视口尺寸变化 → 重新锚定
        scheduleRebuild(); // 消息列高度变化 → 重新量长
      });
      state.ro.observe(flow);
      state.ro.observe(scrollport);

      state.mo = new MutationObserver(function () { scheduleRebuild(); });
      state.mo.observe(flow, { childList: true, subtree: true, characterData: false });

      scrollport.addEventListener("scroll", onScrollPassive, { passive: true });

      rebuild();
      anchor();
      console.log("[conversation-density-map] 已挂载到会话");
    }

    function teardownView() {
      if (state.io) { state.io.disconnect(); state.io = null; }
      if (state.ro) { state.ro.disconnect(); state.ro = null; }
      if (state.mo) { state.mo.disconnect(); state.mo = null; }
      if (state.scrollport) state.scrollport.removeEventListener("scroll", onScrollPassive);
      for (var k in state.tickByKey) {
        var el = state.tickByKey[k];
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      state.tickByKey = Object.create(null);
      state.msgs = [];
      state.textCache = new Map();
      state.rowGroup = new Map();
      state.currentKey = null;
      state.hot = false;
      if (state.rail) { state.rail.classList.remove("is-hot"); state.rail.style.display = "none"; }
      hideTip();
      state.scrollport = null;
      state.flow = null;
    }

    // ------------------------------------------------------------
    // 重建：按「大对话」分组 → 刻度（位置+长度+文本）
    // ------------------------------------------------------------
    function scheduleRebuild() {
      if (state.rebuildTimer !== null) return;
      state.rebuildTimer = setTimeout(function () {
        state.rebuildTimer = null;
        rebuild();
      }, REBUILD_MS);
    }

    function rebuild() {
      var flow = state.flow, sp = state.scrollport;
      if (!flow || !sp || !flow.isConnected) return;

      // 每次重建刷新「是否最大化」：非最大化时所有刻度一律最短
      state.maximized = isMaximized();
      if (state.rail) state.rail.classList.toggle("lite", !state.maximized);

      var rows = flow.querySelectorAll("[data-chat-anchor-key]");
      var flowRect = flow.getBoundingClientRect();
      var scrollH = flow.scrollHeight;
      if (!(scrollH > 0)) { hideRailIfEmpty(); return; }

      // 1) 分组：每条用户消息 = 一个用户标签；其后的 assistant-step/tool-call
      //    全部并入当前「AI 大对话」标签；其它节点忽略（不标签、不打断分组）。
      var groups = [];
      var openAi = null;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var kind = row.getAttribute("data-chat-flow-kind");
        if (kind === USER_KIND) {
          openAi = null;
          groups.push({ kind: "user", row: row });
        } else if (AI_MEMBER_KINDS[kind]) {
          if (openAi === null) { openAi = { kind: "ai", rows: [] }; groups.push(openAi); }
          openAi.rows.push(row);
        }
      }

      // 2) 每个分组的测量快照：位置中心、长度、行引用
      var entries = [];
      var index = 0;
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        index += 1;
        if (grp.kind === "user") {
          var uRect = grp.row.getBoundingClientRect();
          var uh = uRect.height > 0 ? uRect.height : 0;
          entries.push({
            groupKey: "u:" + grp.row.getAttribute("data-chat-anchor-key"),
            kind: "user",
            refRow: grp.row,
            memberRows: [grp.row],
            h: uh,
            centerTop: uRect.top - flowRect.top + uRect.height / 2,
            index: index,
          });
        } else {
          var first = grp.rows[0], last = grp.rows[grp.rows.length - 1];
          var fRect = first.getBoundingClientRect();
          var lRect = last.getBoundingClientRect();
          // 整段 AI 大对话的跨距（首行顶 → 末行底，含工具卡片）
          var span = Math.max(0, lRect.bottom - fRect.top);
          entries.push({
            groupKey: "a:" + first.getAttribute("data-chat-anchor-key"),
            kind: "ai",
            refRow: first,
            memberRows: grp.rows,
            h: span,
            centerTop: (fRect.top + lRect.bottom) / 2 - flowRect.top,
            index: index,
          });
        }
      }

      // 3) 刻度同步（增量创建 / 移除）
      var tickByKey = state.tickByKey;
      var seen = Object.create(null);
      var msgs = [];
      var observeTargets = [];
      state.rowGroup = new Map();
      for (var e = 0; e < entries.length; e++) {
        var ent = entries[e];
        seen[ent.groupKey] = true;
        var pct = (ent.centerTop / scrollH) * 100;
        if (pct < 0) pct = 0; else if (pct > 100) pct = 100;
        pct = Math.round(pct * 10) / 10;

        var tick = tickByKey[ent.groupKey];
        if (tick === undefined) {
          tick = document.createElement("div");
          tick.className = "dsh-dmap-tick";
          tick.setAttribute("data-dsh-tick", "");
          tick.addEventListener("mouseenter", onTickEnter);
          tick.addEventListener("mouseleave", onTickLeave);
          state.rail.appendChild(tick);
          tickByKey[ent.groupKey] = tick;
        }
        var w = state.maximized
          ? Math.round(BASE_W + (MAX_W - BASE_W) * Math.sqrt(Math.min(1, ent.h / REF_H)))
          : BASE_W;
        tick.style.top = pct + "%";
        tick.dshBasePct = pct;
        tick.style.setProperty("--dsh-dtick-w", w + "px");
        tick.classList.toggle("current", ent.groupKey === state.currentKey);
        tick.dshMeta = { key: ent.groupKey, kind: ent.kind, index: ent.index, refRow: ent.refRow };
        paintGroup(ent);
        for (var mm = 0; mm < ent.memberRows.length; mm++) {
          var ak = ent.memberRows[mm].getAttribute("data-chat-anchor-key");
          if (ak) { state.rowGroup.set(ak, ent.groupKey); observeTargets.push(ent.memberRows[mm]); }
        }
        msgs.push(tick);
      }

      // 移除已消失分组的刻度
      for (var k in tickByKey) {
        if (!seen[k]) {
          var el = tickByKey[k];
          if (el && el.parentNode) el.parentNode.removeChild(el);
          delete tickByKey[k];
        }
      }
      state.msgs = msgs;

      // 4) 重建 IntersectionObserver（阅读带）
      if (state.io) state.io.disconnect();
      state.io = new IntersectionObserver(onIntersect, {
        root: sp,
        rootMargin: "-" + Math.round(BAND_TOP * 100) + "% 0px -" + Math.round((1 - BAND_TOP - BAND_HEIGHT) * 100) + "% 0px",
        threshold: [0, 0.25, 0.5, 1],
      });
      for (var ob = 0; ob < observeTargets.length; ob++) state.io.observe(observeTargets[ob]);

      hideRailIfEmpty();
      anchor();
      if (state.hot) spreadTicks();
    }

    // 文本/tooltip 数据：只在跨度明显变化或首次出现时重读
    function paintGroup(ent) {
      var key = ent.groupKey, h = ent.h;
      var cached = state.textCache.get(key);
      if (cached !== undefined && cached.h0 > 0 && (h - cached.h0) / cached.h0 <= THRESH) return;
      var total = 0, first = "";
      for (var i = 0; i < ent.memberRows.length; i++) {
        var kind = ent.memberRows[i].getAttribute("data-chat-flow-kind");
        if (kind !== "assistant-step" && kind !== USER_KIND) continue;
        var txt = "";
        try { txt = (ent.memberRows[i].textContent || "").replace(/\s+/g, " ").trim(); } catch (e2) { txt = ""; }
        if (ent.kind === "user") { first = txt.slice(0, 56); break; } // 用户标签只用消息本身
        total += txt.length;
        if (first === "" && txt !== "") first = txt.slice(0, 56);
      }
      // AI 大对话：字数 = 各段文本之和；用户消息：字数 = 消息文本长度
      state.textCache.set(key, { h0: h, len: ent.kind === "user" ? first.length : total, first: first });
    }

    function hideRailIfEmpty() {
      if (!state.rail) return;
      var any = false;
      for (var k in state.tickByKey) { any = true; break; }
      state.rail.style.display = any ? "" : "none";
    }

    // ------------------------------------------------------------
    // 当前位置（IntersectionObserver 阅读带，行 → 所属大对话标签）
    // ------------------------------------------------------------
    function onIntersect(entries) {
      var sp = state.scrollport;
      if (!sp) return;
      var r = sp.getBoundingClientRect();
      var bandCenter = r.top + r.height * (BAND_TOP + BAND_HEIGHT / 2);
      var best = null, bestDist = Infinity;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        var er = e.boundingClientRect;
        var center = er.top + er.height / 2;
        var d = Math.abs(center - bandCenter);
        if (d < bestDist) { bestDist = d; best = e.target; }
      }
      if (best) {
        var rowKey = best.getAttribute("data-chat-anchor-key");
        var groupKey = state.rowGroup.get(rowKey);
        if (groupKey !== undefined && groupKey !== state.currentKey) setCurrent(groupKey);
      }
    }

    function setCurrent(groupKey) {
      state.currentKey = groupKey;
      for (var k in state.tickByKey) {
        state.tickByKey[k].classList.toggle("current", k === groupKey);
      }
    }

    // 滚动时：隐藏 tooltip；到底时兜底定位到最后一个大对话（O(1)）
    function onScrollPassive() {
      hideTip();
      if (state.pendingFrame) return;
      state.pendingFrame = true;
      requestAnimationFrame(function () {
        state.pendingFrame = false;
        var sp = state.scrollport;
        if (!sp) return;
        if (sp.scrollTop + sp.clientHeight >= sp.scrollHeight - 24) {
          var last = state.msgs[state.msgs.length - 1];
          if (last && last.dshMeta && last.dshMeta.key !== state.currentKey) setCurrent(last.dshMeta.key);
        }
      });
    }

    // ------------------------------------------------------------
    // 点击跳转（跳到大对话的开头）
    // ------------------------------------------------------------
    function onClickTick(ev) {
      var target = ev.target;
      if (!(target instanceof Element)) return;
      var tick = target.closest("[data-dsh-tick]");
      if (!tick || !tick.dshMeta || !tick.dshMeta.refRow) return;
      hideTip();
      tick.dshMeta.refRow.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    }

    // ------------------------------------------------------------
    // 悬停：接近右缘展开 + 刻度 tooltip
    // ------------------------------------------------------------
    function onDocMove(ev) {
      var sp = state.scrollport, rail = state.rail;
      if (!sp || !rail) { setHot(false); return; }
      if (rail.style.display === "none") { setHot(false); return; }
      var r = sp.getBoundingClientRect();
      var near = ev.clientX > r.right - 42 && ev.clientX < r.right + 8 &&
        ev.clientY > r.top && ev.clientY < r.bottom;
      setHot(near);
    }

    function setHot(on) {
      if (state.hot === on) return;
      state.hot = on;
      if (state.rail) state.rail.classList.toggle("is-hot", on);
      if (on) spreadTicks(); else restoreTicks();
    }

    // 悬停疏散（仅展示层）：鼠标靠近时按对话顺序把相邻刻度推开到最小间距，
    // 避免密集对话两端糊在一起难点击；移开即还原为比例位置。不改分组/长度/跳转。
    function spreadTicks() {
      var rail = state.rail, msgs = state.msgs;
      if (!rail || msgs.length < 2) return;
      var H = parseInt(rail.style.height, 10);
      if (!(H > 0)) return;
      var n = msgs.length;
      var gap = Math.min(9, (H - 16) / n);
      if (gap < 3) gap = 3;
      var ys = new Array(n);
      var prev = 8;
      for (var i = 0; i < n; i++) {
        var base = ((msgs[i].dshBasePct || 0) / 100) * H;
        var y = Math.max(base, prev);
        if (y > H - 8) y = H - 8;
        ys[i] = y;
        prev = y + gap;
      }
      var next = H - 8;
      for (var j = n - 1; j >= 0; j--) {
        var y2 = Math.min(ys[j], next);
        if (y2 < 8) y2 = 8;
        ys[j] = y2;
        next = y2 - gap;
      }
      for (var k = 0; k < n; k++) msgs[k].style.top = Math.round(ys[k]) + "px";
    }
    function restoreTicks() {
      var msgs = state.msgs;
      for (var i = 0; i < msgs.length; i++) {
        var t = msgs[i];
        if (t.dshBasePct !== undefined) t.style.top = t.dshBasePct + "%";
      }
    }

    function onTickEnter(ev) {
      var tick = ev.currentTarget;
      var meta = tick.dshMeta;
      if (!meta) return;
      var c = state.textCache.get(meta.key);
      var who = meta.kind === "user" ? "用户对话" : "AI 对话";
      var label = who + " · 第 " + meta.index + " 条";
      if (c !== undefined && c.len > 0) label += " · 约 " + c.len + " 字";
      if (c !== undefined && c.first) label += "：「" + c.first + "」";
      showTip(label, tick);
    }

    function onTickLeave() { hideTip(); }

    function showTip(text, tick) {
      var tip = state.tip;
      if (!tip) return;
      tip.textContent = text;
      var r = tick.getBoundingClientRect();
      var top = r.top + r.height / 2;
      if (top < 10) top = 10; else if (top > window.innerHeight - 14) top = window.innerHeight - 14;
      tip.style.top = top + "px";
      tip.style.right = (window.innerWidth - r.left + 14) + "px";
      tip.style.maxWidth = Math.max(120, r.left - 18) + "px";
      tip.classList.add("show");
    }

    function hideTip() {
      if (state.tip) state.tip.classList.remove("show");
    }

    // ------------------------------------------------------------
    // 锚定：rail 固定在滚动视口右缘中部（fixed 覆盖层，不占布局）
    // ------------------------------------------------------------
    function anchor() {
      var sp = state.scrollport, rail = state.rail;
      if (!sp || !rail) return;
      var r = sp.getBoundingClientRect();
      var h = r.height - 48;
      if (h < 80) h = 80;
      if (h > 460) h = 460;
      rail.style.top = (r.top + r.height / 2) + "px";
      rail.style.height = h + "px";
      rail.style.right = (window.innerWidth - r.right + 14) + "px";
    }

    function onWinResize() { anchor(); scheduleRebuild(); }

    // ------------------------------------------------------------
    // 一次性样式（data-plugin-css 惯例，随插件卸载移除；动画/适配不变）
    // ------------------------------------------------------------
    function insertStyle() {
      var tagId = "@dsh-conversation-density-map/rail.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return null;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-conversation-density-map";
      tag.dataset.pluginCss = tagId;
      tag.textContent = [
        ".dsh-dmap{position:fixed;z-index:26;pointer-events:none;width:26px;transform:translateY(-50%)}",
        ".dsh-dmap-tick{position:absolute;left:50%;height:2.5px;border-radius:2px;background:var(--dsw-alias-label-tertiary);opacity:.34;transform:translate(-50%,-50%);cursor:pointer;pointer-events:auto;width:var(--dsh-dtick-w,8px);transition:top .16s ease,width .16s ease,opacity .18s ease,background .2s ease,box-shadow .25s ease}",
        ".dsh-dmap-tick:after{content:\"\";position:absolute;left:-10px;right:-6px;top:-8px;bottom:-8px}",
        ".dsh-dmap-tick.current{opacity:1;background:var(--dsw-alias-label-primary);width:calc(var(--dsh-dtick-w,8px) + 4px);box-shadow:0 0 7px 1px color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent)}",
        ".dsh-dmap.is-hot .dsh-dmap-tick{opacity:.6}",
        ".dsh-dmap.is-hot .dsh-dmap-tick.current{opacity:1}",
        ".dsh-dmap.lite .dsh-dmap-tick,.dsh-dmap.lite .dsh-dmap-tick.current,.dsh-dmap.lite.is-hot .dsh-dmap-tick{width:var(--dsh-dtick-w,8px)}",
        ".dsh-dmap-tip{position:fixed;pointer-events:none;z-index:40;transform:translateY(-50%);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 8px;box-shadow:var(--dsw-shadow-lv1,none);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:opacity .12s ease}",
        ".dsh-dmap-tip.show{opacity:1}",
        "@media (prefers-reduced-motion:reduce){.dsh-dmap-tick,.dsh-dmap-tip{transition:none}}",
      ].join("\n");
      document.head.appendChild(tag);
      return tag;
    }

    // ------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------
    function apply(ctx) {
      if (typeof document === "undefined") return;
      try { state.styleEl = insertStyle(); } catch (e) { state.styleEl = null; }
      createChrome();
      ensureBound();
      console.log("[conversation-density-map] 对话密度地图已加载（纯客户端展示层）");
      ctx.effect(function () {
        return function cleanup() {
          teardownView();
          disposeChrome();
          if (state.styleEl && state.styleEl.parentNode) state.styleEl.parentNode.removeChild(state.styleEl);
          state.styleEl = null;
          if (state.rebuildTimer !== null) { clearTimeout(state.rebuildTimer); state.rebuildTimer = null; }
          if (reboundTimer !== null) { clearTimeout(reboundTimer); reboundTimer = null; }
        };
      });
    }

    exports.apply = apply;
    return module.exports;
  },
});
