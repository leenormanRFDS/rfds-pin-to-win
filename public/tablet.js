/* Safari's visual viewport follows the keyboard and browser bars without user-agent detection. */
(() => {
  const root = document.documentElement, modals = [...document.querySelectorAll('.modal-shell')]; let frame = 0;
  function updateViewport() {
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      const height = Math.round(viewport?.height || window.innerHeight), top = Math.round(viewport?.offsetTop || 0);
      root.style.setProperty('--visual-height', height + 'px'); root.style.setProperty('--visual-top', top + 'px');
      const open = modals.some(m => m.classList.contains('open')); root.classList.toggle('registration-open', open);
      if (!open && (!viewport || Math.abs(viewport.scale - 1) < .01)) root.style.setProperty('--app-height', height + 'px');
    });
  }
  window.addEventListener('resize', updateViewport); window.addEventListener('pageshow', updateViewport);
  window.visualViewport?.addEventListener('resize', updateViewport); window.visualViewport?.addEventListener('scroll', updateViewport);
  modals.forEach(modal => new MutationObserver(updateViewport).observe(modal, { attributes: true, attributeFilter: ['class'] }));
  // Enter moves through the registration fields instead of submitting early on the iPad keyboard.
  [['player-name', 'player-email'], ['player-email', 'player-org']].forEach(([from, to]) => document.getElementById(from).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById(to).focus(); } }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateViewport(); syncPending(); if (screens.board.classList.contains('active')) populateBoard(); } });
  let markerFrame = 0;
  function keepMarkersRegistered() {
    cancelAnimationFrame(markerFrame); markerFrame = requestAnimationFrame(() => {
      if (!state.current || !screens.game.classList.contains('active')) return;
      applyMapView(); refreshMarkers();
    });
  }
  if (window.ResizeObserver) new ResizeObserver(keepMarkersRegistered).observe(document.getElementById('map-canvas'));
  updateViewport();
})();
