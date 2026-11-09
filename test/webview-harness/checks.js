/* Scripted interactions for the harness; select with ?script=checks.js&case=... (see README.md). */
(function () {
  const q = new URLSearchParams(location.search);
  const C = q.get('case');
  const R = window.__report;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const btn = (txt) => $$('button').find((b) => b.textContent.trim() === txt || b.getAttribute('aria-label') === txt);
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const nodes = () => $$('.node').length;
  const wait = async () => { await tick(400); };

  (async () => {
    try {
      await wait();
      if (C === 'big') {
        R({ nodes: nodes(), edges: $$('.edge').length });
        btn('Export').click();
        const item = $$('button,[role=menuitem]').find((b) => /svg/i.test(b.textContent));
        const t = performance.now();
        item.click();
        const m = window.__posted.filter((p) => p.type === 'exportSvg').pop();
        R({ exportMs: Math.round(performance.now() - t), svgKB: m ? Math.round(m.svg.length / 1024) : null });
      } else if (C === 'hostile') {
        R({ scripts: $$('script').length, xss: window.__xss === undefined, svgHasRawScriptTag: (btn('Export') && !!$$('svg script').length) });
        window.__send({ type: 'focus', entityId: 'nope' });
        await tick(100);
        R({ afterUnknownFocus: nodes(), sel: $$('.node.selected').length });
        const input = $('.tb-input');
        for (const s of ['(', '[a-', '.*', '\\', '$^', '<script>', '👩', 'x'.repeat(5000)]) { input.value = s; input.dispatchEvent(new Event('input')); }
        R({ searchOk: true, count: $('.tb-search-count').textContent });
      } else if (C === 'update') {
        // select, start dragging, update model removing the selection mid-drag
        const g = $$('.node')[0];
        const id = g.getAttribute('data-id');
        const r = g.getBoundingClientRect();
        const svg = $('svg.diagram');
        const ev = (t, x, y) => svg.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }));
        g.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.x + 20, clientY: r.y + 10, button: 0, pointerId: 1, bubbles: true }));
        ev('pointermove', r.x + 60, r.y + 40);
        const next = window.__cases.basic();
        next.entities = next.entities.filter((e) => e.id !== id);
        next.relations = [];
        window.__send({ type: 'model', model: next, layout: {} });
        await tick(100);
        ev('pointermove', r.x + 90, r.y + 70);
        ev('pointerup', r.x + 90, r.y + 70);
        R({ removed: id, nodesNow: nodes(), selected: $$('.node.selected').length, sidePanel: ($('.side-panel') || {}).textContent ? 'ok' : 'none' });
      } else if (C === 'keyboard') {
        const first = $$('.node')[0];
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await tick(100);
        R({ selectedAfterEnter: $$('.node.selected').length, focusVisible: document.activeElement === first, tabIndexes: $$('.node').every((n) => n.tabIndex === 0) });
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await tick(50);
        R({ selectedAfterEsc: $$('.node.selected').length });
      }
    } catch (e) { R({ error: String(e && e.stack || e) }); }
  })();
})();
