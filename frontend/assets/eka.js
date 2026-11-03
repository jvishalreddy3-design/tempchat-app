/* EKA landing atmosphere.
 *
 * A deliberately tiny, dependency-free enhancement layer: one canvas of soft
 * drifting light motes, intersection reveals, and a desktop-only pointer
 * parallax. Everything here is decorative and degrades to a static page when
 * JavaScript, canvas, or motion is unavailable.
 */
(function () {
  'use strict';

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(pointer: fine)');
  const canvas = document.getElementById('eka-particles');
  const landing = document.getElementById('landing-view');
  let reduced = motionQuery.matches;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let frame = 0;
  let lastTime = 0;
  let context = null;

  function landingIsVisible() {
    if (!landing) return false;
    return !landing.classList.contains('hidden') && !document.body.classList.contains('account-mode');
  }

  function createParticles() {
    const target = width < 520 ? 16 : width < 960 ? 26 : 38;
    particles = Array.from({ length: target }, () => {
      const radius = Math.random() * 2.4 + 0.8;
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        radius,
        speed: Math.random() * 0.22 + 0.06,
        drift: (Math.random() - 0.5) * 0.16,
        alpha: Math.random() * 0.34 + 0.16,
        hue: Math.random() > 0.52 ? '255, 110, 170' : '155, 116, 250'
      };
    });
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width || window.innerWidth));
    height = Math.max(1, Math.round(rect.height || window.innerHeight));
    dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context = canvas.getContext('2d');
    if (context) context.setTransform(dpr, 0, 0, dpr, 0, 0);
    createParticles();
    draw(0);
  }

  function draw(delta) {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    for (const particle of particles) {
      particle.y -= particle.speed * delta * 0.06;
      particle.x += particle.drift * delta * 0.06;
      if (particle.y < -12) particle.y = height + 12;
      if (particle.x < -12) particle.x = width + 12;
      if (particle.x > width + 12) particle.x = -12;

      const glow = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, particle.radius * 6);
      glow.addColorStop(0, `rgba(${particle.hue}, ${particle.alpha})`);
      glow.addColorStop(1, `rgba(${particle.hue}, 0)`);
      context.fillStyle = glow;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.radius * 6, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = `rgba(255, 255, 255, ${particle.alpha + 0.22})`;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.radius * 0.62, 0, Math.PI * 2);
      context.fill();
    }
  }

  function loop(time) {
    frame = 0;
    if (reduced || document.hidden || !landingIsVisible()) return;
    const delta = lastTime ? Math.min(time - lastTime, 48) : 16;
    lastTime = time;
    draw(delta);
    frame = window.requestAnimationFrame(loop);
  }

  function start() {
    if (frame || reduced || document.hidden || !landingIsVisible()) return;
    lastTime = 0;
    frame = window.requestAnimationFrame(loop);
  }

  function stop() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  }

  // -------------------------------------------------------------------------
  // Entrance reveals
  // -------------------------------------------------------------------------

  const revealTargets = [
    '.eka-hero-copy',
    '.eka-hero-visual',
    '.eka-feature',
    '.eka-footer'
  ];

  let revealTimer = 0;

  function revealAll() {
    for (const element of document.querySelectorAll('.eka-reveal')) element.classList.add('is-visible');
  }

  function scheduleRevealFallback() {
    window.clearTimeout(revealTimer);
    if (reduced) {
      revealAll();
      return;
    }
    revealTimer = window.setTimeout(revealAll, 1400);
  }

  function installReveals() {
    if (!('IntersectionObserver' in window)) return;
    const elements = [];
    for (const selector of revealTargets) {
      for (const element of document.querySelectorAll(selector)) elements.push(element);
    }
    if (!elements.length) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { root: null, rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    elements.forEach((element, index) => {
      element.classList.add('eka-reveal');
      element.style.transitionDelay = `${Math.min(index * 60, 300)}ms`;
      observer.observe(element);
    });
    scheduleRevealFallback();
  }

  // -------------------------------------------------------------------------
  // Desktop pointer parallax
  // -------------------------------------------------------------------------

  function installParallax() {
    const visual = document.querySelector('.eka-hero-visual');
    if (!visual || !finePointer.matches || reduced) return;
    let queued = false;
    let pointerX = 0;
    let pointerY = 0;
    visual.addEventListener('pointermove', (event) => {
      if (window.innerWidth < 900) return;
      const rect = visual.getBoundingClientRect();
      pointerX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      pointerY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        visual.style.transform = `translate3d(${pointerX * 7}px, ${pointerY * 7}px, 0)`;
      });
    });
    visual.addEventListener('pointerleave', () => {
      visual.style.transform = '';
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function applyMotionPreference() {
    reduced = motionQuery.matches;
    document.documentElement.dataset.reducedMotion = reduced ? 'true' : 'false';
    if (reduced) {
      revealAll();
      stop();
    } else {
      start();
    }
  }

  function boot() {
    if (!canvas) return;
    resize();
    installReveals();
    installParallax();
    applyMotionPreference();

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 180);
    }, { passive: true });

    motionQuery.addEventListener?.('change', applyMotionPreference);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });

    // The landing is hidden while the account app is active. Watching the body
    // class avoids running the canvas behind an opaque screen.
    if ('MutationObserver' in window) {
      new MutationObserver(() => {
        if (landingIsVisible()) {
          start();
          scheduleRevealFallback();
        } else {
          stop();
        }
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
