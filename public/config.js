/* Pin to Win settings you can change without touching game code.
   Leave a value as '' to switch that feature off. */
window.PTW_CONFIG = {
  // Link shown in the registration collection notice. Use the RFDS SA/NT privacy policy URL.
  privacyUrl: '',

  // Optional call to action on the mission summary screen, e.g. a donate or regular-giving page.
  // Add a tracking parameter such as ?utm_source=pin-to-win&utm_medium=game so you can see results in GA4.
  ctaUrl: '',
  ctaLabel: 'Support the Flying Doctor',
  ctaCopy: 'Every tasking in this game is a real kind of journey the RFDS makes every day.',

  // Google Tag Manager container ID (e.g. 'GTM-XXXXXXX'). Game events are pushed to dataLayer either way.
  gtmId: '',

  // Kiosk timings, in seconds.
  idleResetSeconds: 90,      // Result, summary, leaderboard and registration screens return to start.
  idleGameSeconds: 120,      // Mid-flight: ask "Still flying?" after this long.
  idleCountdownSeconds: 20,  // Then return to start (progress is saved and resumable).
  resumeWindowMinutes: 20    // How long an unfinished game is offered on the start screen.
};
