(() => {
  const canvas = document.getElementById('cv');
  const ctx = canvas.getContext('2d', { alpha: true });

  /** Logical size (DIP / CSS px) — must match rects and main-process virtual bounds mapping. */
  let logicalW = 0;
  let logicalH = 0;

  /** @type {{ x: number, y: number, w: number, h: number }[]} */
  let rects = [];
  let drawingMode = false;
  /** @type {{ start: { x: number, y: number }, curr: { x: number, y: number } } | null} */
  let drag = null;

  /** Last value sent to main for `setIgnoreMouseEvents` (passthrough hover). */
  let lastSentPassThrough = undefined;

  function sendMouseThrough(passThrough) {
    if (lastSentPassThrough === passThrough) return;
    lastSentPassThrough = passThrough;
    window.irisShell?.send?.('overlay:set-mouse-through', { passThrough });
  }

  /** Hit target for the dismiss control (top-right of each rect), canvas px. */
  function dismissBounds(r) {
    const btn = Math.min(26, Math.max(16, Math.round(Math.min(r.w, r.h) * 0.28)));
    const pad = 5;
    const x = r.x + r.w - btn - pad;
    const y = r.y + pad;
    return { x, y, w: btn, h: btn };
  }

  function pointInRect(px, py, b) {
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  /** @returns {number} index or -1 */
  function dismissHitTest(px, py) {
    for (let i = rects.length - 1; i >= 0; i--) {
      if (pointInRect(px, py, dismissBounds(rects[i]))) return i;
    }
    return -1;
  }

  function drawDismissChrome(r) {
    const b = dismissBounds(r);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rad = Math.max(3, b.w * 0.38);
    ctx.fillStyle = 'rgba(18, 22, 32, 0.88)';
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(232, 200, 180, 0.95)';
    ctx.lineWidth = Math.max(1.5, rad * 0.2);
    ctx.lineCap = 'round';
    const inset = rad * 0.45;
    ctx.beginPath();
    ctx.moveTo(cx - inset, cy - inset);
    ctx.lineTo(cx + inset, cy + inset);
    ctx.moveTo(cx + inset, cy - inset);
    ctx.lineTo(cx - inset, cy + inset);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** Smallest positive value — avoids scrollbar gutter / subpixel mismatch (esp. vertical). */
  function minViewportDim(...vals) {
    const nums = vals.filter((n) => typeof n === 'number' && n > 0);
    return nums.length ? Math.min(...nums) : 1;
  }

  /** Sync canvas CSS size to the visible client area only (never larger than the window). */
  function applyViewportCss() {
    const vv = window.visualViewport;
    const vw = Math.max(
      1,
      Math.floor(
        minViewportDim(
          document.documentElement.clientWidth,
          window.innerWidth,
          vv?.width
        )
      )
    );
    const vh = Math.max(
      1,
      Math.floor(
        minViewportDim(
          document.documentElement.clientHeight,
          window.innerHeight,
          vv?.height
        )
      )
    );
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    canvas.style.boxSizing = 'border-box';
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
    canvas.style.left = '0';
    canvas.style.top = '0';
  }

  function lockDocumentScroll() {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }

  lockDocumentScroll();
  window.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
    },
    { passive: false, capture: true }
  );

  /**
   * @param {number} [w] - content width from main `getContentBounds()` (matches IPC mapping)
   * @param {number} [h]
   */
  function fitCanvas(w, h) {
    const hasIpc = typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0;
    if (hasIpc) {
      logicalW = w;
      logicalH = h;
      canvas.width = w;
      canvas.height = h;
    } else if (logicalW >= 1 && logicalH >= 1) {
      /* Window resize: keep bitmap + logical from last IPC; only adjust CSS to viewport. */
    } else {
      const iw = window.innerWidth;
      const ih = window.innerHeight;
      if (iw < 1 || ih < 1) return;
      logicalW = iw;
      logicalH = ih;
      canvas.width = iw;
      canvas.height = ih;
    }
    applyViewportCss();
    redraw();
  }

  async function invokeGrounding() {
    try {
      await window.irisShell.invokeFocusRectsUpdate({
        rects: rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
        canvasWidth: logicalW || canvas.width,
        canvasHeight: logicalH || canvas.height,
      });
    } catch (e) {
      console.error('focus grounding', e);
    }
  }

  function updateCursor(p) {
    const overDismiss = rects.length > 0 && dismissHitTest(p.x, p.y) >= 0;
    if (drawingMode) {
      canvas.style.cursor = overDismiss ? 'pointer' : 'crosshair';
    } else {
      canvas.style.cursor = overDismiss ? 'pointer' : 'default';
    }
  }

  function syncPointerPolicy(p) {
    if (drawingMode || !rects.length) return;
    const overDismiss = dismissHitTest(p.x, p.y) >= 0;
    sendMouseThrough(!overDismiss);
  }

  function redraw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (drawingMode) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
      ctx.fillRect(0, 0, w, h);
    }

    rects.forEach((r, i) => {
      ctx.fillStyle = 'rgba(69, 104, 130, 0.35)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#d2c1b6';
      ctx.lineWidth = Math.max(2, Math.round(w / 600));
      ctx.setLineDash([]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.max(14, Math.round(w / 90))}px system-ui, Segoe UI, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 4;
      ctx.fillText(String(i + 1), r.x + 8, r.y + Math.max(20, Math.round(w / 85)));
      ctx.shadowBlur = 0;
      drawDismissChrome(r);
    });

    if (drag && drag.curr) {
      const x = Math.min(drag.start.x, drag.curr.x);
      const y = Math.min(drag.start.y, drag.curr.y);
      const rw = Math.abs(drag.curr.x - drag.start.x);
      const rh = Math.abs(drag.curr.y - drag.start.y);
      ctx.strokeStyle = '#e8b339';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(x, y, rw, rh);
      ctx.setLineDash([]);
    }
  }

  function clientToCanvas(ev) {
    const r = canvas.getBoundingClientRect();
    const lw = logicalW || canvas.width;
    const lh = logicalH || canvas.height;
    const sx = lw / Math.max(1, r.width);
    const sy = lh / Math.max(1, r.height);
    return {
      x: (ev.clientX - r.left) * sx,
      y: (ev.clientY - r.top) * sy,
    };
  }

  function onPointerDown(ev) {
    const p = clientToCanvas(ev);
    const dIdx = rects.length ? dismissHitTest(p.x, p.y) : -1;
    if (dIdx >= 0) {
      ev.preventDefault();
      rects.splice(dIdx, 1);
      drag = null;
      redraw();
      void invokeGrounding();
      if (!rects.length) {
        sendMouseThrough(true);
      } else {
        syncPointerPolicy(p);
      }
      return;
    }
    if (!drawingMode) return;
    ev.preventDefault();
    drag = { start: { ...p }, curr: { ...p } };
    canvas.setPointerCapture(ev.pointerId);
    redraw();
  }

  function onPointerMove(ev) {
    if (!drawingMode || !drag) return;
    drag.curr = clientToCanvas(ev);
    redraw();
  }

  function onPointerUp(ev) {
    if (!drawingMode || !drag) return;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    const x0 = drag.start.x;
    const y0 = drag.start.y;
    const x1 = drag.curr.x;
    const y1 = drag.curr.y;
    drag = null;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const rw = Math.abs(x1 - x0);
    const rh = Math.abs(y1 - y0);
    const MIN = 12;
    if (rw >= MIN && rh >= MIN) {
      rects.push({ x, y, w: rw, h: rh });
    }
    redraw();
  }

  function onPointerCancel() {
    drag = null;
    redraw();
  }

  let boundDraw = false;

  function setDrawingMoveListeners(on) {
    if (on && !boundDraw) {
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      boundDraw = true;
    } else if (!on && boundDraw) {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      boundDraw = false;
    }
    redraw();
  }

  function onWindowPointerMove(ev) {
    const p = clientToCanvas(ev);
    if (rects.length && !drawingMode) {
      syncPointerPolicy(p);
    }
    updateCursor(p);
  }

  function onWindowPointerLeave() {
    if (drawingMode) {
      canvas.style.cursor = 'crosshair';
      return;
    }
    sendMouseThrough(true);
    canvas.style.cursor = 'default';
  }

  canvas.addEventListener('pointerdown', onPointerDown);

  window.addEventListener('pointermove', onWindowPointerMove, { passive: true });
  window.addEventListener('pointerleave', onWindowPointerLeave);

  window.addEventListener('resize', () => fitCanvas());
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => fitCanvas());
  }

  if (window.irisShell?.on) {
    window.irisShell.on('overlay:set-drawing', (payload) => {
      drawingMode = !!(payload && payload.drawing);
      if (!drawingMode) drag = null;
      setDrawingMoveListeners(drawingMode);
      lastSentPassThrough = undefined;
      if (!drawingMode) {
        sendMouseThrough(true);
      }
      redraw();
    });

    window.irisShell.on('overlay:reposition', (payload) => {
      fitCanvas(payload?.width, payload?.height);
    });

    window.irisShell.on('overlay:clear', () => {
      rects = [];
      drag = null;
      drawingMode = false;
      setDrawingMoveListeners(false);
      lastSentPassThrough = undefined;
      sendMouseThrough(true);
      redraw();
    });

    window.irisShell.on('overlay:request-grounding', () => void invokeGrounding());
  }

  requestAnimationFrame(() => fitCanvas());
})();
