/**
 * Dedicated Background Web Worker for Audio Visualizer
 * Runs 100% off the main thread via OffscreenCanvas.
 * Ensures ZERO UI thread lag on mobile and desktop.
 */

import { GenZVisualizerEngine } from './visualizer-engine.js';

let engine = null;
let canvas = null;
let isHidden = false;
let isMobile = false;
let lastDrawTime = 0;
let rafId = null;

function renderLoop(time = performance.now()) {
  rafId = requestAnimationFrame(renderLoop);

  if (isHidden) return;

  // Frame throttle inside worker: 30 FPS on mobile (33ms), 50 FPS on desktop (20ms)
  const interval = isMobile ? 33 : 20;
  if (time - lastDrawTime < interval) return;
  lastDrawTime = time;

  if (engine) {
    engine.render(time);
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'init': {
      canvas = msg.canvas;
      if (!canvas) return;

      canvas.width = msg.width || 300;
      canvas.height = msg.height || 150;
      isMobile = !!msg.isMobile;

      const ctx = canvas.getContext('2d', { alpha: true });
      engine = new GenZVisualizerEngine(ctx, {
        width: canvas.width,
        height: canvas.height,
        dpr: msg.dpr || 1,
        isMobile: isMobile
      });

      if (!rafId) {
        rafId = requestAnimationFrame(renderLoop);
      }
      break;
    }

    case 'resize': {
      if (canvas && engine) {
        canvas.width = msg.width || canvas.width;
        canvas.height = msg.height || canvas.height;
        engine.resize(canvas.width, canvas.height, msg.dpr || 1);
      }
      break;
    }

    case 'audio': {
      if (engine && msg.data) {
        engine.updateAudio(msg.data);
      }
      break;
    }

    case 'visibility': {
      isHidden = !!msg.hidden;
      break;
    }
  }
};
