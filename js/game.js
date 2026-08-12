// 1800年 世界国境パズル - メインロジック (バニラJS + Canvas)
(() => {
  const board = document.getElementById("board");
  const bctx = board.getContext("2d");
  const dragLayer = document.getElementById("dragLayer");
  const dctx = dragLayer.getContext("2d");

  const trayList = document.getElementById("trayList");
  const trayCountEl = document.getElementById("trayCount");
  const progressEl = document.getElementById("progress");
  const timerEl = document.getElementById("timer");
  const hintToggle = document.getElementById("hintToggle");
  const resetBtn = document.getElementById("resetBtn");
  const changeModeBtn = document.getElementById("changeModeBtn");
  const winOverlay = document.getElementById("winOverlay");
  const winTimeEl = document.getElementById("winTime");
  const playAgainBtn = document.getElementById("playAgainBtn");
  const modeOverlay = document.getElementById("modeOverlay");
  const modeGrid = document.getElementById("modeGrid");
  const pageTitle = document.getElementById("pageTitle");

  const answerBtn = document.getElementById("answerBtn");
  const answerOverlay = document.getElementById("answerOverlay");
  const answerTitle = document.getElementById("answerTitle");
  const answerCanvasWrap = document.getElementById("answerCanvasWrap");
  const answerCanvas = document.getElementById("answerCanvas");
  const actx = answerCanvas.getContext("2d");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomResetBtn = document.getElementById("zoomResetBtn");
  const closeAnswerBtn = document.getElementById("closeAnswerBtn");

  const boardPanel = document.getElementById("boardPanel");
  const canvasStack = document.querySelector(".canvas-stack");
  const boardZoomInBtn = document.getElementById("boardZoomInBtn");
  const boardZoomOutBtn = document.getElementById("boardZoomOutBtn");
  const boardZoomResetBtn = document.getElementById("boardZoomResetBtn");

  const W = board.width;
  const H = board.height;

  // null = 世界全体モード。それ以外は REGION_META のキー。
  const REGION_META = [
    { key: null, label: "世界全体", cls: "world" },
    { key: "europe", label: "ヨーロッパ" },
    { key: "africa", label: "アフリカ" },
    { key: "americas", label: "南北アメリカ" },
    { key: "wsasia", label: "西アジア・南アジア" },
    { key: "easia", label: "東アジア・東南アジア" },
    { key: "oceania", label: "オセアニア" },
  ];

  let currentRegion = null;
  let countries = []; // 現在のモードでプレイ可能な国(placedフラグ付き)
  let backgroundCountries = []; // プレイ不可(他地域)の国。背景として表示のみ
  let placedCount = 0;
  let startTime = null;
  let timerInterval = null;
  let dragging = null; // { country, cx, cy } cx/cy = current board-canvas pos of piece centroid

  // ---------- 投影(座標変換)のセットアップ ----------
  const PAD = 16;
  let mainFit;

  // ヨーロッパモードでロシア帝国の東端(シベリア方面)まで含めると、
  // ヨーロッパ諸国が小さくなりすぎるため、ウラル山脈付近(東経60度)で打ち切る。
  // これは初期表示のズーム計算だけでなく、配置判定の目標点(重心)にも
  // 同じ基準を使う。そうしないと「見えている範囲」と「実際に置くべき場所」が
  // ズレてしまい、ロシアを配置できなくなる。ロシア自体の形はそのまま描画され、
  // ズーム・パン操作で東側も見に行ける。
  const REGION_BBOX_LON_CAP = {
    europe: { "Russian Empire": 60 },
  };

  function effectiveBbox(country) {
    const lonCap = REGION_BBOX_LON_CAP[currentRegion] || {};
    let [bx0, by0, bx1, by1] = country.bbox;
    if (country.name in lonCap) bx1 = Math.min(bx1, lonCap[country.name]);
    return [bx0, by0, bx1, by1];
  }

  function effectiveCentroid(country) {
    const [bx0, by0, bx1, by1] = effectiveBbox(country);
    return [(bx0 + bx1) / 2, (by0 + by1) / 2];
  }

  function bboxOfPlayable() {
    // 地域モードではプレイ対象の国だけでズームする。世界全体モードでは
    // neutralLand(未確定地域)も含めた地球全体の範囲を使う。
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const c of countries) {
      const [bx0, by0, bx1, by1] = effectiveBbox(c);
      minx = Math.min(minx, bx0); miny = Math.min(miny, by0);
      maxx = Math.max(maxx, bx1); maxy = Math.max(maxy, by1);
    }
    if (currentRegion === null) {
      for (const polys of GAME_DATA.neutralLand) {
        for (const poly of polys) {
          for (const ring of poly) {
            for (const [x, y] of ring) {
              minx = Math.min(minx, x); maxx = Math.max(maxx, x);
              miny = Math.min(miny, y); maxy = Math.max(maxy, y);
            }
          }
        }
      }
    }
    return [minx, miny, maxx, maxy];
  }

  function makeFitter(bbox, areaX, areaY, areaW, areaH, pad) {
    const [minx, miny, maxx, maxy] = bbox;
    const rangeX = Math.max(maxx - minx, 0.0001);
    const rangeY = Math.max(maxy - miny, 0.0001);
    const scale = Math.min((areaW - pad * 2) / rangeX, (areaH - pad * 2) / rangeY);
    const pxW = rangeX * scale, pxH = rangeY * scale;
    const offX = areaX + pad + (areaW - pad * 2 - pxW) / 2;
    const offY = areaY + pad + (areaH - pad * 2 - pxH) / 2;
    return {
      scale,
      project: (x, y) => [offX + (x - minx) * scale, offY + (y - miny) * scale],
      centroidPx: (cx, cy) => [offX + (cx - minx) * scale, offY + (cy - miny) * scale],
    };
  }

  function setupProjection() {
    mainFit = makeFitter(bboxOfPlayable(), 0, 0, W, H, PAD);
  }

  // ---------- ポリゴン描画ヘルパ ----------
  function pathFor(ctx, polygons, project) {
    ctx.beginPath();
    for (const poly of polygons) {
      for (const ring of poly) {
        ring.forEach(([x, y], i) => {
          const [cx, cy] = project(x, y);
          if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
        });
        ctx.closePath();
      }
    }
  }

  function drawNeutralLand(ctx) {
    ctx.fillStyle = "#1c2536";
    for (const polys of GAME_DATA.neutralLand) {
      pathFor(ctx, polys, mainFit.project);
      ctx.fill("evenodd");
    }
    // 地域モードでは、他地域の国も操作不可の背景として塗っておく
    for (const c of backgroundCountries) {
      pathFor(ctx, c.polygons, mainFit.project);
      ctx.fill("evenodd");
    }
  }

  function drawWorldOutline(ctx) {
    // 国境ではなく、全陸地の外周(海岸線)だけを描く
    ctx.save();
    ctx.strokeStyle = "rgba(148,163,184,0.7)";
    ctx.lineWidth = 1.2;
    ctx.lineJoin = "round";
    for (const line of GAME_DATA.outline) {
      ctx.beginPath();
      line.forEach(([x, y], i) => {
        const [cx, cy] = mainFit.project(x, y);
        if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCountry(ctx, country, mode) {
    // mode: "hint" | "solid" | "drag"
    pathFor(ctx, country.polygons, mainFit.project);
    if (mode === "hint") {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(148,163,184,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (mode === "solid") {
      ctx.fillStyle = "rgba(34,197,94,0.85)";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1;
      ctx.stroke();
      drawLabel(ctx, country);
    } else if (mode === "drag") {
      ctx.fillStyle = "rgba(56,189,248,0.55)";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // 配置済みの国の中心にラベルを描く。国の形からはみ出さないようclipし、
  // 小さい国は自動的に文字を縮小する
  function drawLabel(ctx, country) {
    const [bx0, by0, bx1, by1] = country.bbox;
    const pxW = (bx1 - bx0) * mainFit.scale;
    const pxH = (by1 - by0) * mainFit.scale;
    const [x, y] = mainFit.centroidPx(country.labelPoint[0], country.labelPoint[1]);
    const label = country.labelJa;

    if (Math.min(pxW, pxH) < 16) {
      // 国の形が小さすぎてラベルが収まらない場合は、
      // 引き出し線なしの小さな目印(ドット)+ 形の外にはみ出すラベルにする
      ctx.save();
      ctx.fillStyle = "#f8fafc";
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();

      const lx = x + 6, ly = y - 5;
      ctx.font = "600 9px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(15,23,42,0.9)";
      ctx.strokeText(label, lx, ly);
      ctx.fillText(label, lx, ly);
      ctx.restore();
      return;
    }

    let fontSize = Math.max(7, Math.min(13, Math.floor(Math.min(pxW, pxH) * 0.4)));

    ctx.save();
    pathFor(ctx, country.polygons, mainFit.project);
    ctx.clip("evenodd");
    ctx.font = `600 ${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, fontSize * 0.28);
    ctx.strokeStyle = "rgba(15,23,42,0.9)";
    ctx.strokeText(label, x, y);
    ctx.fillStyle = "#f8fafc";
    ctx.fillText(label, x, y);
    ctx.restore();
  }

  function render() {
    bctx.clearRect(0, 0, W, H);
    bctx.fillStyle = "#0b1220";
    bctx.fillRect(0, 0, W, H);

    drawNeutralLand(bctx);

    const showHints = hintToggle.checked;
    if (!showHints) drawWorldOutline(bctx);

    for (const c of countries) {
      if (c.placed) {
        drawCountry(bctx, c, "solid");
      } else if (showHints) {
        // ヒントON: 国ごとの境界線を明示する
        drawCountry(bctx, c, "hint");
      }
    }
  }

  function renderDragLayer() {
    dctx.clearRect(0, 0, W, H);
    if (!dragging) return;
    const [ecx, ecy] = effectiveCentroid(dragging.country);
    const [tcx, tcy] = mainFit.centroidPx(ecx, ecy);
    const dx = dragging.cx - tcx;
    const dy = dragging.cy - tcy;
    const shiftedProject = (x, y) => {
      const [cx, cy] = mainFit.project(x, y);
      return [cx + dx, cy + dy];
    };
    pathFor(dctx, dragging.country.polygons, shiftedProject);
    dctx.fillStyle = "rgba(56,189,248,0.55)";
    dctx.fill("evenodd");
    dctx.strokeStyle = "#38bdf8";
    dctx.lineWidth = 2;
    dctx.stroke();
  }

  // ---------- トレイ(未配置リスト)UI ----------
  function thumbCanvas(country) {
    const c = document.createElement("canvas");
    c.width = 46; c.height = 30;
    const cx2 = c.getContext("2d");
    const fit = makeFitter(country.bbox, 0, 0, 46, 30, 3);
    pathFor(cx2, country.polygons, fit.project);
    cx2.fillStyle = "#94a3b8";
    cx2.fill("evenodd");
    return c;
  }

  function buildTray() {
    trayList.innerHTML = "";
    const remaining = countries.filter(c => !c.placed).sort((a, b) => a.nameJa.localeCompare(b.nameJa, "ja"));
    for (const c of remaining) {
      const li = document.createElement("li");
      li.className = "tray-item";
      li.dataset.id = c.id;
      li.appendChild(thumbCanvas(c));
      const nameSpan = document.createElement("span");
      nameSpan.className = "name";
      nameSpan.textContent = `${c.nameJa} (${c.name})`;
      li.appendChild(nameSpan);
      li.addEventListener("pointerdown", (e) => startDrag(e, c, li));
      trayList.appendChild(li);
    }
    trayCountEl.textContent = `(残り ${remaining.length})`;
  }

  // ---------- ドラッグ操作 (マウス/タッチ/ペンをPointer Eventsで統一) ----------
  function boardPos(evt) {
    const rect = board.getBoundingClientRect();
    const scaleX = board.width / rect.width;
    const scaleY = board.height / rect.height;
    return [(evt.clientX - rect.left) * scaleX, (evt.clientY - rect.top) * scaleY];
  }

  function startDrag(evt, country, li) {
    evt.preventDefault();
    if (!startTime) startTimer();
    dragging = { country, cx: -9999, cy: -9999, li };
    li.classList.add("dragging-source");
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
    document.addEventListener("pointercancel", onDragEnd);
    onDragMove(evt);
  }

  function onDragMove(evt) {
    if (!dragging) return;
    const [x, y] = boardPos(evt);
    dragging.cx = x;
    dragging.cy = y;
    renderDragLayer();
  }

  function tolerancePx(country) {
    const [bx0, by0, bx1, by1] = effectiveBbox(country);
    const w = (bx1 - bx0) * mainFit.scale;
    const h = (by1 - by0) * mainFit.scale;
    const diag = Math.sqrt(w * w + h * h);
    return Math.min(60, Math.max(18, diag * 0.35));
  }

  function onDragEnd(evt) {
    if (!dragging) return;
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    document.removeEventListener("pointercancel", onDragEnd);

    const country = dragging.country;
    const [ecx, ecy] = effectiveCentroid(country);
    const [tcx, tcy] = mainFit.centroidPx(ecx, ecy);
    const dist = Math.hypot(dragging.cx - tcx, dragging.cy - tcy);
    const tol = tolerancePx(country);

    dragging.li.classList.remove("dragging-source");

    if (dist <= tol) {
      country.placed = true;
      placedCount++;
      dragging = null;
      dctx.clearRect(0, 0, W, H);
      buildTray();
      render();
      updateProgress();
      checkWin();
    } else {
      dragging = null;
      dctx.clearRect(0, 0, W, H);
    }
  }

  // ---------- 進捗・タイマー ----------
  function updateProgress() {
    progressEl.textContent = `${placedCount} / ${countries.length}`;
  }

  function startTimer() {
    startTime = Date.now();
    timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss = String(sec % 60).padStart(2, "0");
      timerEl.textContent = `${mm}:${ss}`;
    }, 250);
  }

  function stopTimer() {
    clearInterval(timerInterval);
  }

  function checkWin() {
    if (placedCount === countries.length) {
      stopTimer();
      winTimeEl.textContent = `タイム: ${timerEl.textContent}`;
      winOverlay.classList.remove("hidden");
    }
  }

  // ---------- 初期化・リセット ----------
  function initGame() {
    const all = GAME_DATA.countries;
    if (currentRegion === null) {
      countries = all.map(c => ({ ...c, placed: false }));
      backgroundCountries = [];
    } else {
      countries = all.filter(c => c.regions.includes(currentRegion)).map(c => ({ ...c, placed: false }));
      backgroundCountries = all.filter(c => !c.regions.includes(currentRegion));
    }
    placedCount = 0;
    startTime = null;
    stopTimer();
    timerEl.textContent = "00:00";
    winOverlay.classList.add("hidden");
    setupProjection();
    buildTray();
    render();
    updateProgress();
    fitBoardToPanel();
  }

  function startGame(regionKey) {
    currentRegion = regionKey;
    const meta = REGION_META.find(r => r.key === regionKey);
    pageTitle.textContent = regionKey === null
      ? "1800年 世界国境パズル"
      : `1800年 世界国境パズル - ${meta.label}`;
    modeOverlay.classList.add("hidden");
    initGame();
  }

  function buildModeGrid() {
    modeGrid.innerHTML = "";
    for (const meta of REGION_META) {
      const count = meta.key === null
        ? GAME_DATA.countries.length
        : GAME_DATA.countries.filter(c => c.regions.includes(meta.key)).length;
      const btn = document.createElement("button");
      btn.className = "mode-btn" + (meta.cls ? ` ${meta.cls}` : "");
      btn.innerHTML = `${meta.label}<span class="count">${count}ピース</span>`;
      btn.addEventListener("click", () => startGame(meta.key));
      modeGrid.appendChild(btn);
    }
  }

  // ---------- ズーム・パン可能なビューポート(正解マップ / プレイ中の地図で共用) ----------
  // wrapEl: 表示領域(overflow:hiddenのコンテナ), targetEl: 実際に拡大縮小するcanvas/div
  function createPanZoom(wrapEl, targetEl, { maxZoom = 8, onChange } = {}) {
    const state = { baseScale: 1, z: 1, tx: 0, ty: 0 };
    const pointers = new Map();
    let panPointerId = null;
    let panStart = null;
    let pinchStartDist = null;

    function totalScale() {
      return state.baseScale * state.z;
    }

    function apply() {
      targetEl.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${totalScale()})`;
      if (onChange) onChange();
    }

    function fit() {
      const rect = wrapEl.getBoundingClientRect();
      state.baseScale = Math.max(0.01, Math.min(rect.width / W, rect.height / H));
      state.z = 1;
      const s = totalScale();
      state.tx = (rect.width - W * s) / 2;
      state.ty = (rect.height - H * s) / 2;
      apply();
    }

    function zoomAt(cx, cy, factor) {
      const oldScale = totalScale();
      const contentX = (cx - state.tx) / oldScale;
      const contentY = (cy - state.ty) / oldScale;
      state.z = Math.min(maxZoom, Math.max(1, state.z * factor));
      const newScale = totalScale();
      state.tx = cx - contentX * newScale;
      state.ty = cy - contentY * newScale;
      apply();
    }

    function pinchDist() {
      const pts = [...pointers.values()];
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    wrapEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = wrapEl.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    }, { passive: false });

    wrapEl.addEventListener("pointerdown", (e) => {
      try { wrapEl.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        panPointerId = e.pointerId;
        panStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
        wrapEl.classList.add("dragging");
      } else if (pointers.size === 2) {
        panPointerId = null;
        pinchStartDist = pinchDist();
      }
    });

    wrapEl.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const rect = wrapEl.getBoundingClientRect();
        const pts = [...pointers.values()];
        const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
        const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
        const dist = pinchDist();
        zoomAt(midX, midY, dist / pinchStartDist);
        pinchStartDist = dist;
      } else if (panPointerId === e.pointerId) {
        state.tx = panStart.tx + (e.clientX - panStart.x);
        state.ty = panStart.ty + (e.clientY - panStart.y);
        apply();
      }
    });

    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (panPointerId === e.pointerId) {
        panPointerId = null;
        wrapEl.classList.remove("dragging");
      }
      if (pointers.size < 2) pinchStartDist = null;
      if (pointers.size === 1) {
        const [id, pt] = [...pointers.entries()][0];
        panPointerId = id;
        panStart = { x: pt.x, y: pt.y, tx: state.tx, ty: state.ty };
      }
    }
    wrapEl.addEventListener("pointerup", endPointer);
    wrapEl.addEventListener("pointercancel", endPointer);

    return { fit, zoomAt, state };
  }

  const answerPanZoom = createPanZoom(answerCanvasWrap, answerCanvas);
  function fitAnswerToWrap() { answerPanZoom.fit(); }
  function zoomAt(cx, cy, factor) { answerPanZoom.zoomAt(cx, cy, factor); }

  function renderAnswerMap() {
    actx.clearRect(0, 0, W, H);
    actx.fillStyle = "#0b1220";
    actx.fillRect(0, 0, W, H);
    drawNeutralLand(actx);
    for (const c of countries) {
      drawCountry(actx, c, "solid");
    }
  }

  function openAnswerOverlay() {
    answerTitle.textContent = `${pageTitle.textContent} - 正解マップ`;
    renderAnswerMap();
    answerOverlay.classList.remove("hidden");
    requestAnimationFrame(fitAnswerToWrap);
  }

  zoomInBtn.addEventListener("click", () => {
    const rect = answerCanvasWrap.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 1.4);
  });
  zoomOutBtn.addEventListener("click", () => {
    const rect = answerCanvasWrap.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 1 / 1.4);
  });
  zoomResetBtn.addEventListener("click", fitAnswerToWrap);
  closeAnswerBtn.addEventListener("click", () => answerOverlay.classList.add("hidden"));
  answerBtn.addEventListener("click", openAnswerOverlay);

  // ---------- プレイ中の地図のズーム・パン ----------
  const boardPanZoom = createPanZoom(boardPanel, canvasStack, {
    maxZoom: 10,
    onChange: renderDragLayer, // パン/ズーム後もドラッグ中のピースの見た目位置がずれないように再描画
  });
  function fitBoardToPanel() { boardPanZoom.fit(); }

  boardZoomInBtn.addEventListener("click", () => {
    const rect = boardPanel.getBoundingClientRect();
    boardPanZoom.zoomAt(rect.width / 2, rect.height / 2, 1.4);
  });
  boardZoomOutBtn.addEventListener("click", () => {
    const rect = boardPanel.getBoundingClientRect();
    boardPanZoom.zoomAt(rect.width / 2, rect.height / 2, 1 / 1.4);
  });
  boardZoomResetBtn.addEventListener("click", fitBoardToPanel);

  window.addEventListener("resize", () => {
    fitBoardToPanel();
    if (!answerOverlay.classList.contains("hidden")) fitAnswerToWrap();
  });

  hintToggle.addEventListener("change", render);
  resetBtn.addEventListener("click", initGame);
  playAgainBtn.addEventListener("click", initGame);
  changeModeBtn.addEventListener("click", () => {
    stopTimer();
    modeOverlay.classList.remove("hidden");
  });

  buildModeGrid();
})();
