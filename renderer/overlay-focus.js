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

  /**
   * @param {number} [w] - from main `getVirtualBounds()` (use when window is hidden; innerWidth is often 0)
   * @param {number} [h]
   */
  function fitCanvas(w, h) {
    const aw = typeof w === 'number' && w > 0 ? w : window.innerWidth;
    const ah = typeof h === 'number' && h > 0 ? h : window.innerHeight;
    if (aw < 1 || ah < 1) return;
    logicalW = aw;
    logicalH = ah;
    canvas.width = aw;
    canvas.height = ah;
    redraw();
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
      ctx.fillStyle = 'rgba(124, 156, 255, 0.2)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#7c9cff';
      ctx.lineWidth = Math.max(2, Math.round(w / 600));
      ctx.setLineDash([]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.max(14, Math.round(w / 90))}px system-ui, Segoe UI, sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 4;
      ctx.fillText(String(i + 1), r.x + 8, r.y + Math.max(20, Math.round(w / 85)));
      ctx.shadowBlur = 0;
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
    if (!drawingMode) return;
    ev.preventDefault();
    const p = clientToCanvas(ev);
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
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    const MIN = 12;
    if (w >= MIN && h >= MIN) {
      rects.push({ x, y, w, h });
    }
    redraw();
  }

  function onPointerCancel() {
    drag = null;
    redraw();
  }

  let boundDown = false;

  function setDrawingListeners(on) {
    if (on && !boundDown) {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      boundDown = true;
    } else if (!on && boundDown) {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      boundDown = false;
    }
    canvas.style.cursor = on ? 'crosshair' : 'default';
  }

  window.addEventListener('resize', fitCanvas);

  if (window.irisShell?.on) {
    window.irisShell.on('overlay:set-drawing', (payload) => {
      drawingMode = !!(payload && payload.drawing);
      setDrawingListeners(drawingMode);
      redraw();
    });

    window.irisShell.on('overlay:reposition', (payload) => {
      fitCanvas(payload?.width, payload?.height);
    });

    window.irisShell.on('overlay:clear', () => {
      rects = [];
      drag = null;
      drawingMode = false;
      setDrawingListeners(false);
      redraw();
    });

    window.irisShell.on('overlay:request-grounding', async () => {
      try {
        await window.irisShell.invokeFocusRectsUpdate({
          rects: rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
          canvasWidth: logicalW || canvas.width,
          canvasHeight: logicalH || canvas.height,
        });
      } catch (e) {
        console.error('focus grounding', e);
      }
    });
  }

  requestAnimationFrame(() => fitCanvas());
})();
