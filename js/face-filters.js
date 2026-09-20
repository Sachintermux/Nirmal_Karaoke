/**
 * Nirmal Karaoke - Snapchat-Style Face Filters & Dual Camera Switcher Engine
 * Provides real-time AR face filters, smooth face tracking, front/rear camera switching,
 * and high-performance WebRTC canvas stream generation.
 */

export const FACE_FILTERS = [
  { id: 'none', label: 'Normal', icon: '✨', title: 'Clean natural camera' },
  { id: 'dog', label: 'Puppy Dog', icon: '🐶', title: 'Classic puppy ears, nose & tongue' },
  { id: 'cat', label: 'Cute Kitty', icon: '🐱', title: 'Pink kitty ears, whiskers & blush' },
  { id: 'glasses', label: 'Cool Shades', icon: '🕶️', title: 'Dark thug life sunglasses & gold chain' },
  { id: 'crown', label: 'Royal Crown', icon: '👑', title: 'Golden sparkling crown & gems' },
  { id: 'halo', label: 'Angel Halo', icon: '😇', title: 'Glowing angel halo & sparkles' },
  { id: 'cyber', label: 'Cyberpunk', icon: '🤖', title: 'Neon HUD visor & targeting' },
  { id: 'glam', label: 'Beauty Glam', icon: '💖', title: 'Rosy blush, radiance & soft glow' },
  { id: 'fire', label: 'Inferno Horns', icon: '🔥', title: 'Blazing fire horns & rising embers' },
  { id: 'rainbow', label: 'Rainbow Pop', icon: '🌈', title: 'Vibrant rainbow aura & floating stars' },
  { id: 'comic', label: 'Comic Noir', icon: '🎨', title: 'Dramatic comic sketch & noir vignette' }
];

export class FaceFilterEngine {
  constructor(options = {}) {
    this.width = options.width || 640;
    this.height = options.height || 360;
    this.currentFilter = options.initialFilter || 'none';
    this.facingMode = 'user'; // 'user' (front) or 'environment' (rear)
    this.currentDeviceId = null;
    this.availableCameras = [];
    this.currentCameraIndex = 0;

    this.active = false;
    this.rawStream = null;
    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.style.display = 'none';
    document.body.appendChild(this.video);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.canvasStream = null;
    this.outputTrack = null;

    this.animId = null;
    this.startTime = performance.now();
    this.lastFrameTime = performance.now();

    // Particle states for animated filters (halo, crown, fire, rainbow)
    this.particles = [];
    this.initParticles();

    // Smoothed face state
    this.face = {
      x: this.width * 0.5,
      y: this.height * 0.44,
      w: this.width * 0.36,
      h: this.height * 0.52,
      angle: 0,
      eyes: {
        left: { x: this.width * 0.42, y: this.height * 0.4 },
        right: { x: this.width * 0.58, y: this.height * 0.4 }
      },
      nose: { x: this.width * 0.5, y: this.height * 0.47 },
      mouth: { x: this.width * 0.5, y: this.height * 0.57 },
      detected: false
    };

    // Contain bounding box for letterbox/pillarbox rendering
    this.drawBox = { x: 0, y: 0, w: this.width, h: this.height };

    // Detectors
    this.nativeDetector = null;
    this.mpFaceDetector = null;
    this.mpLoading = false;
    this.offCanvas = null;
    this.offCtx = null;
    this.detectorBusy = false;
    this.detectionCounter = 0;

    this.initDetector();
    this.initMediaPipe();
  }

  async initDetector() {
    if (typeof window !== 'undefined' && 'FaceDetector' in window) {
      try {
        this.nativeDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      } catch (_) {
        this.nativeDetector = null;
      }
    }
  }

  initMediaPipe() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (window.FaceDetection) {
      this.setupMediaPipeInstance();
      return;
    }
    if (this.mpLoading) return;
    this.mpLoading = true;

    const existing = document.querySelector('script[data-mp-face]');
    if (existing) {
      existing.addEventListener('load', () => this.setupMediaPipeInstance());
      return;
    }

    const script = document.createElement('script');
    script.setAttribute('data-mp-face', 'true');
    script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/face_detection.js';
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      this.setupMediaPipeInstance();
    };
    script.onerror = () => {
      console.warn('[FaceFilter] MediaPipe CDN not reachable; continuing with instant zero-dependency canvas tracker.');
    };
    document.head.appendChild(script);
  }

  setupMediaPipeInstance() {
    if (!window.FaceDetection || this.mpFaceDetector) return;
    try {
      const fd = new window.FaceDetection({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`
      });
      fd.setOptions({
        model: 'short',
        minDetectionConfidence: 0.5
      });
      fd.onResults((results) => {
        if (results.detections && results.detections.length > 0) {
          this.processMediaPipeResult(results.detections[0]);
        }
      });
      this.mpFaceDetector = fd;
    } catch (err) {
      console.warn('[FaceFilter] MediaPipe setup failed:', err);
    }
  }

  initParticles() {
    this.particles = [];
    for (let i = 0; i < 24; i++) {
      this.particles.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        vx: (Math.random() - 0.5) * 1.5,
        vy: -0.8 - Math.random() * 2.0,
        size: 3 + Math.random() * 5,
        alpha: Math.random(),
        hue: Math.random() * 360,
        life: Math.random() * 100
      });
    }
  }

  async enumerateCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.availableCameras = devices.filter(d => d.kind === 'videoinput');
      return this.availableCameras;
    } catch (_) {
      this.availableCameras = [];
      return [];
    }
  }

  async startCamera(options = {}) {
    await this.enumerateCameras();
    if (options.facingMode) this.facingMode = options.facingMode;
    if (options.deviceId) this.currentDeviceId = options.deviceId;

    const constraints = {
      audio: false,
      video: {
        width: { ideal: this.width },
        height: { ideal: this.height },
        frameRate: { ideal: 30, max: 30 }
      }
    };

    if (this.currentDeviceId) {
      constraints.video.deviceId = { exact: this.currentDeviceId };
    } else {
      constraints.video.facingMode = this.facingMode === 'environment'
        ? { ideal: 'environment' }
        : { ideal: 'user' };
    }

    try {
      this.rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Fallback without deviceId/facingMode if strictly rejected
      console.warn('[FaceFilter] primary camera request failed, attempting fallback:', err?.message || err);
      this.rawStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: this.width }, height: { ideal: this.height } }
      });
    }

    // Determine actual deviceId/facingMode from track settings
    const activeTrack = this.rawStream.getVideoTracks()[0];
    if (activeTrack) {
      const settings = activeTrack.getSettings ? activeTrack.getSettings() : {};
      if (settings.facingMode) this.facingMode = settings.facingMode;
      if (settings.deviceId) this.currentDeviceId = settings.deviceId;
    }

    this.video.srcObject = this.rawStream;
    await new Promise((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.onloadedmetadata = () => resolve();
    });
    try { await this.video.play(); } catch (_) {}

    // Adjust canvas aspect ratio to match actual video stream
    const vw = this.video.videoWidth || this.width;
    const vh = this.video.videoHeight || this.height;
    this.canvas.width = vw;
    this.canvas.height = vh;
    this.width = vw;
    this.height = vh;

    // Capture canvas stream
    if (!this.canvasStream) {
      this.canvasStream = this.canvas.captureStream ? this.canvas.captureStream(30) : this.rawStream;
      this.outputTrack = this.canvasStream.getVideoTracks()[0];
    }

    this.active = true;
    this.startRenderLoop();

    return {
      track: this.outputTrack,
      stream: this.canvasStream,
      facingMode: this.facingMode,
      deviceId: this.currentDeviceId
    };
  }

  async switchCamera() {
    if (!this.active) return null;
    await this.enumerateCameras();

    if (this.availableCameras.length > 1) {
      this.currentCameraIndex = (this.currentCameraIndex + 1) % this.availableCameras.length;
      this.currentDeviceId = this.availableCameras[this.currentCameraIndex].deviceId;
      // Toggle facingMode heuristic based on device label
      const label = (this.availableCameras[this.currentCameraIndex].label || '').toLowerCase();
      if (label.includes('back') || label.includes('rear') || label.includes('environment')) {
        this.facingMode = 'environment';
      } else if (label.includes('front') || label.includes('user') || label.includes('face')) {
        this.facingMode = 'user';
      } else {
        this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
      }
    } else {
      this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
      this.currentDeviceId = null;
    }

    // Stop previous raw camera stream
    if (this.rawStream) {
      this.rawStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    }

    const constraints = {
      audio: false,
      video: {
        width: { ideal: this.width },
        height: { ideal: this.height },
        frameRate: { ideal: 30, max: 30 }
      }
    };

    if (this.currentDeviceId && this.availableCameras.length > 1) {
      constraints.video.deviceId = { exact: this.currentDeviceId };
    } else {
      constraints.video.facingMode = this.facingMode === 'environment' ? { ideal: 'environment' } : { ideal: 'user' };
    }

    try {
      this.rawStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn('[FaceFilter] camera switch failed, falling back:', e);
      this.rawStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: this.width }, height: { ideal: this.height } }
      });
    }

    this.video.srcObject = this.rawStream;
    await new Promise((resolve) => {
      if (this.video.readyState >= 2) return resolve();
      this.video.onloadedmetadata = () => resolve();
    });
    try { await this.video.play(); } catch (_) {}

    return {
      facingMode: this.facingMode,
      deviceId: this.currentDeviceId,
      camerasCount: this.availableCameras.length
    };
  }

  isFrontCamera() {
    return this.facingMode !== 'environment';
  }

  setFilter(filterId) {
    if (FACE_FILTERS.some(f => f.id === filterId)) {
      this.currentFilter = filterId;
      return true;
    }
    return false;
  }

  getFilter() {
    return this.currentFilter;
  }

  stopCamera() {
    this.active = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.rawStream) {
      this.rawStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      this.rawStream = null;
    }
    if (this.outputTrack) {
      try { this.outputTrack.stop(); } catch (_) {}
      this.outputTrack = null;
    }
    this.canvasStream = null;
    try { this.video.pause(); } catch (_) {}
    this.video.srcObject = null;
  }

  startRenderLoop() {
    const loop = (now) => {
      if (!this.active) return;
      this.animId = requestAnimationFrame(loop);
      this.renderFrame(now);
    };
    this.animId = requestAnimationFrame(loop);
  }

  renderFrame(now) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const time = (now - this.startTime) / 1000;

    if (this.video.readyState >= 2) {
      // Fit-contain calculation so video is never stretched, zoomed, or cut up/down
      const vw = this.video.videoWidth || w;
      const vh = this.video.videoHeight || h;
      const canvasAspect = w / h;
      const videoAspect = vw / vh;
      let drawW = w;
      let drawH = h;
      let drawX = 0;
      let drawY = 0;

      if (videoAspect > canvasAspect) {
        // Video is wider than canvas
        drawW = w;
        drawH = w / videoAspect;
        drawY = (h - drawH) / 2;
      } else {
        // Video is taller than canvas (e.g. portrait mobile) - letterbox sides so nothing cuts top/bottom
        drawH = h;
        drawW = h * videoAspect;
        drawX = (w - drawW) / 2;
      }
      this.drawBox = { x: drawX, y: drawY, w: drawW, h: drawH };

      // Fill canvas background with solid black for clean letterbox bars
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);

      // Draw unmirrored natural video on the proper side everywhere
      ctx.drawImage(this.video, drawX, drawY, drawW, drawH);

      // Update real-time face tracking
      this.updateFaceTracking();
    } else {
      ctx.fillStyle = '#0a0812';
      ctx.fillRect(0, 0, w, h);
    }

    // If filter is active, render AR overlays at tracked face position
    if (this.currentFilter !== 'none') {
      this.renderFilter(ctx, this.currentFilter, time);
    }
  }

  applyNormalizedFace(normX, normY, normW, normH) {
    const db = this.drawBox || { x: 0, y: 0, w: this.width, h: this.height };
    const targetX = db.x + normX * db.w;
    const targetY = db.y + normY * db.h;
    const targetW = normW * db.w;
    const targetH = normH * db.h;

    const k = 0.35; // Responsive EMA smoothing for snappy & jitter-free tracking
    this.face.x += (targetX - this.face.x) * k;
    this.face.y += (targetY - this.face.y) * k;
    this.face.w += (targetW - this.face.w) * k;
    this.face.h += (targetH - this.face.h) * k;

    // Derived landmarks
    const eyeOffsetX = targetW * 0.22;
    const eyeOffsetY = targetH * 0.08;
    this.face.eyes.left.x += (targetX - eyeOffsetX - this.face.eyes.left.x) * k;
    this.face.eyes.left.y += (targetY - eyeOffsetY - this.face.eyes.left.y) * k;
    this.face.eyes.right.x += (targetX + eyeOffsetX - this.face.eyes.right.x) * k;
    this.face.eyes.right.y += (targetY - eyeOffsetY - this.face.eyes.right.y) * k;
    this.face.nose.x += (targetX - this.face.nose.x) * k;
    this.face.nose.y += (targetY + targetH * 0.06 - this.face.nose.y) * k;
    this.face.mouth.x += (targetX - this.face.mouth.x) * k;
    this.face.mouth.y += (targetY + targetH * 0.24 - this.face.mouth.y) * k;
    this.face.detected = true;
  }

  processMediaPipeResult(det) {
    if (!det || !det.boundingBox) return;
    const bb = det.boundingBox;
    // MediaPipe FaceDetection provides normalized bounding box [0..1]
    const normX = bb.xCenter;
    const normY = bb.yCenter;
    const normW = bb.width;
    const normH = bb.height;

    this.applyNormalizedFace(normX, normY, normW, normH);

    // Landmarks: 0: right eye, 1: left eye, 2: nose tip, 3: mouth center
    if (det.landmarks && det.landmarks.length >= 4) {
      const db = this.drawBox || { x: 0, y: 0, w: this.width, h: this.height };
      const k = 0.4;
      const l0 = det.landmarks[0];
      const l1 = det.landmarks[1];
      const l2 = det.landmarks[2];
      const l3 = det.landmarks[3];

      const p0x = db.x + l0.x * db.w;
      const p0y = db.y + l0.y * db.h;
      const p1x = db.x + l1.x * db.w;
      const p1y = db.y + l1.y * db.h;

      // Assign leftmost landmark in canvas space to left eye
      const leftEye = p0x < p1x ? { x: p0x, y: p0y } : { x: p1x, y: p1y };
      const rightEye = p0x < p1x ? { x: p1x, y: p1y } : { x: p0x, y: p0y };

      this.face.eyes.left.x += (leftEye.x - this.face.eyes.left.x) * k;
      this.face.eyes.left.y += (leftEye.y - this.face.eyes.left.y) * k;
      this.face.eyes.right.x += (rightEye.x - this.face.eyes.right.x) * k;
      this.face.eyes.right.y += (rightEye.y - this.face.eyes.right.y) * k;

      if (l2) {
        this.face.nose.x += (db.x + l2.x * db.w - this.face.nose.x) * k;
        this.face.nose.y += (db.y + l2.y * db.h - this.face.nose.y) * k;
      }
      if (l3) {
        this.face.mouth.x += (db.x + l3.x * db.w - this.face.mouth.x) * k;
        this.face.mouth.y += (db.y + l3.y * db.h - this.face.mouth.y) * k;
      }

      const dx = rightEye.x - leftEye.x;
      const dy = rightEye.y - leftEye.y;
      this.face.angle = Math.atan2(dy, dx);
    }
  }

  initCanvasTracker() {
    if (typeof document === 'undefined') return;
    if (!this.offCanvas) {
      this.offCanvas = document.createElement('canvas');
      this.offCanvas.width = 64;
      this.offCanvas.height = 48;
      this.offCtx = this.offCanvas.getContext('2d', { willReadFrequently: true });
    }
  }

  trackFaceCanvas() {
    this.initCanvasTracker();
    if (!this.offCtx || this.video.readyState < 2) return null;

    const ow = 64;
    const oh = 48;
    this.offCtx.drawImage(this.video, 0, 0, ow, oh);
    let imgData;
    try {
      imgData = this.offCtx.getImageData(0, 0, ow, oh).data;
    } catch (_) {
      return null;
    }

    let sumX = 0;
    let sumY = 0;
    let totalWeight = 0;
    let minX = ow;
    let maxX = 0;
    let minY = oh;
    let maxY = 0;

    // Scan pixels for human skin chroma
    for (let y = 3; y < oh - 3; y++) {
      const yWeight = y < oh * 0.7 ? 1.4 : 0.6; // Upper face bias
      for (let x = 3; x < ow - 3; x++) {
        const idx = (y * ow + x) * 4;
        const r = imgData[idx];
        const g = imgData[idx + 1];
        const b = imgData[idx + 2];

        // Universal YCbCr skin chrominance test
        const Cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
        const Cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;

        const isSkin = (Cb >= 77 && Cb <= 130) &&
                       (Cr >= 133 && Cr <= 175) &&
                       (r > 45 && g > 30 && b > 20) &&
                       (r > g && r > b) &&
                       (Math.abs(r - g) > 10);

        if (isSkin) {
          const weight = yWeight;
          sumX += x * weight;
          sumY += y * weight;
          totalWeight += weight;

          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (totalWeight > 18) {
      const centX = (sumX / totalWeight) / ow;
      const centY = (sumY / totalWeight) / oh;
      const rawW = (maxX - minX + 4) / ow;
      const rawH = (maxY - minY + 6) / oh;
      const boxW = Math.max(0.18, Math.min(0.65, rawW * 1.15));
      const boxH = Math.max(0.22, Math.min(0.85, rawH * 1.15));

      return {
        normX: centX,
        normY: centY,
        normW: boxW,
        normH: boxH
      };
    }
    return null;
  }

  async updateFaceTracking() {
    this.detectionCounter++;

    // 1. Prioritize MediaPipe if initialized
    if (this.mpFaceDetector && !this.detectorBusy && (this.detectionCounter % 3 === 0)) {
      this.detectorBusy = true;
      try {
        await this.mpFaceDetector.send({ image: this.video });
      } catch (_) {}
      this.detectorBusy = false;
      return;
    }

    // 2. Native FaceDetector if browser supports it
    if (this.nativeDetector && !this.detectorBusy && (this.detectionCounter % 3 === 0)) {
      this.detectorBusy = true;
      try {
        const faces = await this.nativeDetector.detect(this.video);
        if (faces && faces.length > 0) {
          const f = faces[0];
          const bb = f.boundingBox;
          const vw = this.video.videoWidth || this.width;
          const vh = this.video.videoHeight || this.height;

          const normX = (bb.x + bb.width * 0.5) / vw;
          const normY = (bb.y + bb.height * 0.5) / vh;
          const normW = bb.width / vw;
          const normH = bb.height / vh;

          this.applyNormalizedFace(normX, normY, normW, normH);

          if (f.landmarks) {
            const db = this.drawBox || { x: 0, y: 0, w: this.width, h: this.height };
            const k = 0.35;
            for (const lm of f.landmarks) {
              const lx = db.x + (lm.location.x / vw) * db.w;
              const ly = db.y + (lm.location.y / vh) * db.h;
              if (lm.type === 'eye' && lm.location.x < bb.x + bb.width * 0.5) {
                this.face.eyes.left.x += (lx - this.face.eyes.left.x) * k;
                this.face.eyes.left.y += (ly - this.face.eyes.left.y) * k;
              } else if (lm.type === 'eye') {
                this.face.eyes.right.x += (lx - this.face.eyes.right.x) * k;
                this.face.eyes.right.y += (ly - this.face.eyes.right.y) * k;
              } else if (lm.type === 'nose') {
                this.face.nose.x += (lx - this.face.nose.x) * k;
                this.face.nose.y += (ly - this.face.nose.y) * k;
              } else if (lm.type === 'mouth') {
                this.face.mouth.x += (lx - this.face.mouth.x) * k;
                this.face.mouth.y += (ly - this.face.mouth.y) * k;
              }
            }
          }
          this.detectorBusy = false;
          return;
        }
      } catch (_) {}
      this.detectorBusy = false;
    }

    // 3. Ultra-fast Zero-Dependency Skin & Motion Centroid Tracker
    if (this.detectionCounter % 2 === 0) {
      const result = this.trackFaceCanvas();
      if (result) {
        this.applyNormalizedFace(result.normX, result.normY, result.normW, result.normH);
        return;
      }
    }

    // 4. Default gentle centering if no face currently detected
    if (!this.face.detected) {
      const db = this.drawBox || { x: 0, y: 0, w: this.width, h: this.height };
      const defaultX = db.x + db.w * 0.5;
      const defaultY = db.y + db.h * 0.44;
      const defaultW = Math.min(db.w, db.h) * 0.48;
      const defaultH = defaultW * 1.25;
      this.face.x = defaultX;
      this.face.y = defaultY;
      this.face.w = defaultW;
      this.face.h = defaultH;
      this.face.eyes.left = { x: defaultX - defaultW * 0.22, y: defaultY - defaultH * 0.08 };
      this.face.eyes.right = { x: defaultX + defaultW * 0.22, y: defaultY - defaultH * 0.08 };
      this.face.nose = { x: defaultX, y: defaultY + defaultH * 0.06 };
      this.face.mouth = { x: defaultX, y: defaultY + defaultH * 0.24 };
    }
  }

  renderFilter(ctx, filterId, time) {
    const f = this.face;
    const cx = f.x;
    const cy = f.y;
    const fw = f.w;
    const fh = f.h;

    ctx.save();

    switch (filterId) {
      case 'dog':
        this.renderDogFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'cat':
        this.renderCatFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'glasses':
        this.renderGlassesFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'crown':
        this.renderCrownFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'halo':
        this.renderHaloFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'cyber':
        this.renderCyberFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'glam':
        this.renderGlamFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'fire':
        this.renderFireFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'rainbow':
        this.renderRainbowFilter(ctx, cx, cy, fw, fh, time);
        break;
      case 'comic':
        this.renderComicFilter(ctx, cx, cy, fw, fh, time);
        break;
    }

    ctx.restore();
  }

  // 1. 🐶 Puppy Dog Filter
  renderDogFilter(ctx, cx, cy, fw, fh, time) {
    const earW = fw * 0.38;
    const earH = fh * 0.65;
    const earY = cy - fh * 0.45;
    const wiggle = Math.sin(time * 5) * 4;

    // Left Ear
    this.drawDogEar(ctx, cx - fw * 0.45, earY, earW, earH, -0.3 + wiggle * 0.02, false);
    // Right Ear
    this.drawDogEar(ctx, cx + fw * 0.45, earY, earW, earH, 0.3 - wiggle * 0.02, true);

    // Dog Nose
    const noseY = this.face.nose.y || (cy + fh * 0.08);
    const nw = fw * 0.22;
    const nh = nw * 0.68;

    ctx.save();
    ctx.translate(cx, noseY);
    // Dark brown nose shape
    ctx.fillStyle = '#1c130d';
    ctx.beginPath();
    ctx.ellipse(0, 0, nw * 0.5, nh * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Shiny specular highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.ellipse(-nw * 0.16, -nh * 0.16, nw * 0.14, nh * 0.1, -0.2, 0, Math.PI * 2);
    ctx.fill();
    // Center septum line
    ctx.strokeStyle = '#0f0a06';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, nh * 0.3);
    ctx.lineTo(0, nh * 0.7);
    ctx.stroke();
    ctx.restore();

    // Animated Dog Tongue
    const mouthY = this.face.mouth.y || (cy + fh * 0.26);
    const tongueDrop = Math.sin(time * 4) * (fh * 0.04);
    const tw = fw * 0.18;
    const th = fh * 0.28 + tongueDrop;

    ctx.save();
    ctx.translate(cx, mouthY);
    ctx.fillStyle = '#ff6b8b';
    ctx.beginPath();
    ctx.moveTo(-tw * 0.45, 0);
    ctx.quadraticCurveTo(-tw * 0.5, th * 0.7, 0, th);
    ctx.quadraticCurveTo(tw * 0.5, th * 0.7, tw * 0.45, 0);
    ctx.closePath();
    ctx.fill();
    // Tongue middle line
    ctx.strokeStyle = '#e04868';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.lineTo(0, th * 0.75);
    ctx.stroke();
    ctx.restore();

    // Cute Freckles on Muzzle
    ctx.fillStyle = '#3a2010';
    for (let i = -1; i <= 1; i += 2) {
      const mx = cx + i * (fw * 0.18);
      const my = noseY + nh * 0.4;
      for (let d = 0; d < 3; d++) {
        ctx.beginPath();
        ctx.arc(mx + (d - 1) * 6, my + (d % 2) * 5, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawDogEar(ctx, x, y, w, h, rotation, isRight) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    // Outer brown ear
    ctx.fillStyle = '#9b5d32';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(isRight ? w : -w, h * 0.2, isRight ? w * 0.8 : -w * 0.8, h, 0, h);
    ctx.bezierCurveTo(isRight ? -w * 0.3 : w * 0.3, h * 0.8, 0, h * 0.3, 0, 0);
    ctx.closePath();
    ctx.fill();
    // Inner pink ear
    ctx.fillStyle = '#d98b68';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.1);
    ctx.bezierCurveTo(isRight ? w * 0.55 : -w * 0.55, h * 0.3, isRight ? w * 0.45 : -w * 0.45, h * 0.75, 0, h * 0.75);
    ctx.bezierCurveTo(isRight ? -w * 0.1 : w * 0.1, h * 0.6, 0, h * 0.2, 0, h * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 2. 🐱 Cute Kitty Filter
  renderCatFilter(ctx, cx, cy, fw, fh, time) {
    const earW = fw * 0.35;
    const earH = fh * 0.42;
    const earY = cy - fh * 0.52;

    // Left Cat Ear
    this.drawCatEar(ctx, cx - fw * 0.32, earY, earW, earH, -0.2);
    // Right Cat Ear
    this.drawCatEar(ctx, cx + fw * 0.32, earY, earW, earH, 0.2);

    // Cute pink kitty nose
    const noseY = this.face.nose.y || (cy + fh * 0.08);
    ctx.save();
    ctx.translate(cx, noseY);
    ctx.fillStyle = '#ff85a2';
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(-8, -4);
    ctx.lineTo(8, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Kitty Whiskers
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    for (let dir = -1; dir <= 1; dir += 2) {
      const wx = cx + dir * (fw * 0.15);
      const angles = [-0.15, 0, 0.15];
      angles.forEach(ang => {
        ctx.beginPath();
        ctx.moveTo(wx, noseY + 2);
        ctx.lineTo(wx + dir * (fw * 0.32), noseY + 2 + ang * 60);
        ctx.stroke();
      });
    }

    // Rosy Blush
    const blushR = fw * 0.14;
    for (let dir = -1; dir <= 1; dir += 2) {
      const bx = cx + dir * (fw * 0.28);
      const by = cy + fh * 0.12;
      const grad = ctx.createRadialGradient(bx, by, 0, bx, by, blushR);
      grad.addColorStop(0, 'rgba(255, 105, 180, 0.45)');
      grad.addColorStop(1, 'rgba(255, 105, 180, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, blushR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawCatEar(ctx, x, y, w, h, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // Outer ear
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, h * 0.6);
    ctx.lineTo(0, -h * 0.5);
    ctx.lineTo(w * 0.5, h * 0.6);
    ctx.closePath();
    ctx.fill();
    // Inner ear
    ctx.fillStyle = '#ff9ebb';
    ctx.beginPath();
    ctx.moveTo(-w * 0.3, h * 0.5);
    ctx.lineTo(0, -h * 0.32);
    ctx.lineTo(w * 0.3, h * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 3. 🕶️ Cool Shades / Thug Life Filter
  renderGlassesFilter(ctx, cx, cy, fw, fh, time) {
    const eyeY = this.face.eyes.left.y || (cy - fh * 0.08);
    const gw = fw * 0.85;
    const gh = fh * 0.28;

    ctx.save();
    ctx.translate(cx, eyeY);

    // Dark sleek frame
    ctx.fillStyle = '#111';
    ctx.fillRect(-gw * 0.5, -gh * 0.5, gw, gh);

    // Left and right dark gradient lenses
    const lensW = gw * 0.42;
    const lensH = gh * 0.75;
    [-gw * 0.26, gw * 0.26].forEach(lx => {
      const grad = ctx.createLinearGradient(0, -lensH * 0.5, 0, lensH * 0.5);
      grad.addColorStop(0, '#222');
      grad.addColorStop(1, '#050505');
      ctx.fillStyle = grad;
      ctx.fillRect(lx - lensW * 0.5, -lensH * 0.5, lensW, lensH);

      // Iconic white diagonal glare bars (Thug Life)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.moveTo(lx - lensW * 0.25, -lensH * 0.35);
      ctx.lineTo(lx - lensW * 0.1, -lensH * 0.35);
      ctx.lineTo(lx - lensW * 0.4, lensH * 0.35);
      ctx.lineTo(lx - lensW * 0.55, lensH * 0.35);
      ctx.closePath();
      ctx.fill();
    });

    // Gold Chain Necklace
    const neckY = gh * 1.7;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffd700';
    ctx.shadowColor = '#ffae00';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, neckY - fw * 0.2, fw * 0.45, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();

    ctx.restore();
  }

  // 4. 👑 Royal Gold Crown Filter
  renderCrownFilter(ctx, cx, cy, fw, fh, time) {
    const crownW = fw * 0.75;
    const crownH = fh * 0.4;
    const crownY = cy - fh * 0.55;
    const bob = Math.sin(time * 3) * 4;

    ctx.save();
    ctx.translate(cx, crownY + bob);

    // Golden gradient
    const grad = ctx.createLinearGradient(-crownW * 0.5, 0, crownW * 0.5, 0);
    grad.addColorStop(0, '#e5a93b');
    grad.addColorStop(0.5, '#fff1a8');
    grad.addColorStop(1, '#d4942b');
    ctx.fillStyle = grad;
    ctx.shadowColor = '#ffe066';
    ctx.shadowBlur = 14;

    // 5-Point Crown Shape
    ctx.beginPath();
    ctx.moveTo(-crownW * 0.5, crownH * 0.5);
    ctx.lineTo(-crownW * 0.5, 0);
    ctx.lineTo(-crownW * 0.28, crownH * 0.3);
    ctx.lineTo(0, -crownH * 0.5);
    ctx.lineTo(crownW * 0.28, crownH * 0.3);
    ctx.lineTo(crownW * 0.5, 0);
    ctx.lineTo(crownW * 0.5, crownH * 0.5);
    ctx.closePath();
    ctx.fill();

    // Jewel in Center (Ruby)
    ctx.fillStyle = '#ff2255';
    ctx.beginPath();
    ctx.arc(0, -crownH * 0.15, 6, 0, Math.PI * 2);
    ctx.fill();

    // Jewels on sides (Sapphire & Emerald)
    ctx.fillStyle = '#00bbff';
    ctx.beginPath();
    ctx.arc(-crownW * 0.28, crownH * 0.35, 4.5, 0, Math.PI * 2);
    ctx.arc(crownW * 0.28, crownH * 0.35, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Drifting Golden Sparkles
    for (let i = 0; i < 6; i++) {
      const sa = time * 2 + (i * Math.PI) / 3;
      const sx = Math.cos(sa) * (crownW * 0.65);
      const sy = Math.sin(sa * 0.8) * (crownH * 0.6);
      this.drawSparkleStar(ctx, sx, sy, 4 + Math.sin(time * 6 + i) * 2, '#fff275');
    }

    ctx.restore();
  }

  // 5. 😇 Angel Halo Filter
  renderHaloFilter(ctx, cx, cy, fw, fh, time) {
    const haloW = fw * 0.65;
    const haloH = fh * 0.2;
    const haloY = cy - fh * 0.62;
    const bob = Math.sin(time * 3) * 6;

    ctx.save();
    ctx.translate(cx, haloY + bob);

    // Glowing Angel Halo
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 24;
    ctx.lineWidth = 9;
    ctx.strokeStyle = '#ffeaa7';
    ctx.beginPath();
    ctx.ellipse(0, 0, haloW * 0.5, haloH * 0.5, -0.08, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(0, 0, haloW * 0.5, haloH * 0.5, -0.08, 0, Math.PI * 2);
    ctx.stroke();

    // Floating Halo Dust
    for (let i = 0; i < 8; i++) {
      const t = time * 1.5 + (i * Math.PI) / 4;
      const px = Math.cos(t) * (haloW * 0.6);
      const py = Math.sin(t) * (haloH * 0.8) + Math.sin(time * 4 + i) * 8;
      this.drawSparkleStar(ctx, px, py, 3.5, '#fff9d2');
    }

    ctx.restore();
  }

  // 6. 🤖 Cyberpunk 2077 Visor Filter
  renderCyberFilter(ctx, cx, cy, fw, fh, time) {
    const eyeY = this.face.eyes.left.y || (cy - fh * 0.08);
    const vw = fw * 0.88;
    const vh = fh * 0.26;

    ctx.save();
    ctx.translate(cx, eyeY);

    // Neon Cyber Visor
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 18;
    ctx.fillStyle = 'rgba(0, 240, 255, 0.25)';
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 3;

    // Angled sci-fi polygon
    ctx.beginPath();
    ctx.moveTo(-vw * 0.5, -vh * 0.3);
    ctx.lineTo(-vw * 0.35, -vh * 0.5);
    ctx.lineTo(vw * 0.35, -vh * 0.5);
    ctx.lineTo(vw * 0.5, -vh * 0.3);
    ctx.lineTo(vw * 0.42, vh * 0.5);
    ctx.lineTo(-vw * 0.42, vh * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Target reticle on one eye
    const retX = vw * 0.22;
    ctx.strokeStyle = '#ff007f';
    ctx.shadowColor = '#ff007f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(retX, 0, 14, 0, Math.PI * 2);
    ctx.moveTo(retX - 18, 0);
    ctx.lineTo(retX + 18, 0);
    ctx.moveTo(retX, -18);
    ctx.lineTo(retX, 18);
    ctx.stroke();

    // HUD Tech Text
    ctx.fillStyle = '#00f0ff';
    ctx.font = '700 9px monospace';
    ctx.fillText('STAGE://AUDIO.ACTIVE', -vw * 0.4, -vh * 0.15);
    ctx.fillText('TARGET: LOCKED 100%', -vw * 0.4, vh * 0.25);

    // Animated Scanline
    const scanY = (-vh * 0.4) + ((time * 60) % (vh * 0.8));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-vw * 0.4, scanY);
    ctx.lineTo(vw * 0.4, scanY);
    ctx.stroke();

    ctx.restore();
  }

  // 7. 💖 Beauty Glam & Rosy Glow
  renderGlamFilter(ctx, cx, cy, fw, fh, time) {
    // Soft blush on cheekbones
    const blushR = fw * 0.18;
    for (let dir = -1; dir <= 1; dir += 2) {
      const bx = cx + dir * (fw * 0.26);
      const by = cy + fh * 0.08;
      const grad = ctx.createRadialGradient(bx, by, 0, bx, by, blushR);
      grad.addColorStop(0, 'rgba(255, 75, 130, 0.42)');
      grad.addColorStop(1, 'rgba(255, 75, 130, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, blushR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Radiant Eye Glints
    const eyeLeft = this.face.eyes.left;
    const eyeRight = this.face.eyes.right;
    this.drawSparkleStar(ctx, eyeLeft.x - 6, eyeLeft.y - 4, 4.5 + Math.sin(time * 5) * 1.5, '#ffffff');
    this.drawSparkleStar(ctx, eyeRight.x + 6, eyeRight.y - 4, 4.5 + Math.cos(time * 5) * 1.5, '#ffffff');

    // Floating heart glints
    for (let i = 0; i < 4; i++) {
      const ang = time * 1.2 + (i * Math.PI * 0.5);
      const hx = cx + Math.cos(ang) * (fw * 0.52);
      const hy = cy - fh * 0.25 + Math.sin(ang) * (fh * 0.35);
      this.drawMiniHeart(ctx, hx, hy, 8, 'rgba(255, 105, 180, 0.7)');
    }
  }

  // 8. 🔥 Inferno Horns & Fire
  renderFireFilter(ctx, cx, cy, fw, fh, time) {
    const hornY = cy - fh * 0.42;
    const hornW = fw * 0.22;
    const hornH = fh * 0.45;

    // Glowing Horns
    ctx.save();
    ctx.shadowColor = '#ff3300';
    ctx.shadowBlur = 20;

    // Left horn
    this.drawFireHorn(ctx, cx - fw * 0.28, hornY, hornW, hornH, -0.35);
    // Right horn
    this.drawFireHorn(ctx, cx + fw * 0.28, hornY, hornW, hornH, 0.35);

    // Rising animated fire embers
    this.particles.forEach((p, idx) => {
      p.y -= 2.2 + (idx % 3);
      p.x += Math.sin(time * 4 + idx) * 1.2;
      if (p.y < cy - fh * 0.7) {
        p.y = cy - fh * 0.2 + Math.random() * (fh * 0.2);
        p.x = cx + (Math.random() - 0.5) * fw * 0.7;
      }
      ctx.fillStyle = idx % 2 === 0 ? '#ffae00' : '#ff3300';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.7, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  drawFireHorn(ctx, x, y, w, h, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const grad = ctx.createLinearGradient(0, h * 0.5, 0, -h * 0.5);
    grad.addColorStop(0, '#ffd900');
    grad.addColorStop(0.5, '#ff4d00');
    grad.addColorStop(1, '#990000');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-w * 0.4, h * 0.4);
    ctx.quadraticCurveTo(-w * 0.8, -h * 0.2, 0, -h * 0.5);
    ctx.quadraticCurveTo(w * 0.2, -h * 0.1, w * 0.4, h * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 9. 🌈 Rainbow Pop Filter
  renderRainbowFilter(ctx, cx, cy, fw, fh, time) {
    // Flowing rainbow halo / border
    const rx = cx;
    const ry = cy - fh * 0.48;
    const rw = fw * 0.75;
    const rh = fh * 0.3;

    ctx.save();
    ctx.lineWidth = 6;
    const colors = ['#ff0055', '#ff9900', '#ffee00', '#00ff66', '#00ccff', '#aa00ff'];
    colors.forEach((color, i) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.ellipse(rx, ry, rw * 0.5 + i * 4, rh * 0.5 + i * 2, 0, Math.PI, 0);
      ctx.stroke();
    });

    // Floating colorful stars
    for (let i = 0; i < 7; i++) {
      const a = time * 1.5 + (i * Math.PI * 2) / 7;
      const sx = cx + Math.cos(a) * (fw * 0.55);
      const sy = cy - fh * 0.15 + Math.sin(a * 1.2) * (fh * 0.35);
      this.drawSparkleStar(ctx, sx, sy, 5, colors[i % colors.length]);
    }
    ctx.restore();
  }

  // 10. 🎨 Comic Noir Filter
  renderComicFilter(ctx, cx, cy, fw, fh, time) {
    const w = this.width;
    const h = this.height;

    // Vignette Spotlight
    const grad = ctx.createRadialGradient(cx, cy, fw * 0.4, cx, cy, Math.max(w, h) * 0.75);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.7, 'rgba(0,0,0,0.5)');
    grad.addColorStop(1, 'rgba(0,0,0,0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Comic action corner spikes
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(20, 20); ctx.lineTo(60, 20);
    ctx.moveTo(20, 20); ctx.lineTo(20, 60);
    ctx.moveTo(w - 20, 20); ctx.lineTo(w - 60, 20);
    ctx.moveTo(w - 20, 20); ctx.lineTo(w - 20, 60);
    ctx.moveTo(20, h - 20); ctx.lineTo(60, h - 20);
    ctx.moveTo(20, h - 20); ctx.lineTo(20, h - 60);
    ctx.moveTo(w - 20, h - 20); ctx.lineTo(w - 60, h - 20);
    ctx.moveTo(w - 20, h - 20); ctx.lineTo(w - 20, h - 60);
    ctx.stroke();

    // Sound effect comic badge
    ctx.fillStyle = '#ff0055';
    ctx.font = '900 16px "Space Grotesk", sans-serif';
    ctx.save();
    ctx.translate(cx + fw * 0.45, cy - fh * 0.35);
    ctx.rotate(0.2);
    ctx.fillText('LIVE! ★', 0, 0);
    ctx.restore();
  }

  // Helper: 4-Point Star Sparkle
  drawSparkleStar(ctx, x, y, r, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r * 1.8);
    ctx.quadraticCurveTo(x, y, x + r * 1.8, y);
    ctx.quadraticCurveTo(x, y, x, y + r * 1.8);
    ctx.quadraticCurveTo(x, y, x - r * 1.8, y);
    ctx.quadraticCurveTo(x, y, x, y - r * 1.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Helper: Mini Heart
  drawMiniHeart(ctx, x, y, size, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, size * 0.3);
    ctx.bezierCurveTo(-size * 0.5, -size * 0.5, -size, size * 0.1, 0, size);
    ctx.bezierCurveTo(size, size * 0.1, size * 0.5, -size * 0.5, 0, size * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
