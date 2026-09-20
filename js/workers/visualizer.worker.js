let canvas, ctx, w, h, dpr;
let peaks = new Float32Array(512);
let gradientMain, gradientMirror;

self.onmessage = function (e) {
  if (e.data.type === 'INIT') {
    canvas = e.data.canvas;
    ctx = canvas.getContext('2d');
    dpr = e.data.dpr;
    resize(e.data.width, e.data.height);
  } else if (e.data.type === 'RESIZE') {
    resize(e.data.width, e.data.height);
  } else if (e.data.type === 'AUDIO') {
    if (ctx) draw(e.data.data);
  }
};

function resize(width, height) {
  w = width * dpr;
  h = height * dpr;
  canvas.width = w;
  canvas.height = h;
  const baseLine = h * 0.85;
  gradientMain = ctx.createLinearGradient(0, h * 0.1, 0, baseLine);
  gradientMain.addColorStop(0, '#00e5ff');
  gradientMain.addColorStop(0.5, '#a855f7');
  gradientMain.addColorStop(1, '#ff007f');

  gradientMirror = ctx.createLinearGradient(0, baseLine, 0, baseLine + h * 0.2);
  gradientMirror.addColorStop(0, 'rgba(255, 0, 127, 0.35)');
  gradientMirror.addColorStop(1, 'rgba(0, 0, 0, 0)');
}

function draw(data) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.85);
  ctx.lineTo(w, h * 0.85);
  ctx.stroke();

  const numBars = 48;
  const step = Math.floor(data.length / (numBars * 1.8));
  const barSpacing = w / numBars;
  const barWidth = barSpacing * 0.65;
  const baseLine = h * 0.85;

  ctx.fillStyle = gradientMain;
  for (let i = 0; i < numBars; i++) {
    const percent = (data[i * step] || 0) / 255;
    const barHeight = Math.pow(percent, 1.4) * (h * 0.75);
    if (barHeight > peaks[i]) peaks[i] = barHeight;
    else peaks[i] = Math.max(0, peaks[i] - 2.5);

    ctx.beginPath();
    ctx.roundRect(i * barSpacing + (barSpacing - barWidth) / 2, baseLine - barHeight, barWidth, barHeight, [4, 4, 0, 0]);
    ctx.fill();
  }

  ctx.fillStyle = gradientMirror;
  for (let i = 0; i < numBars; i++) {
    const percent = (data[i * step] || 0) / 255;
    const barHeight = Math.pow(percent, 1.4) * (h * 0.75);
    ctx.beginPath();
    ctx.roundRect(i * barSpacing + (barSpacing - barWidth) / 2, baseLine + 2, barWidth, barHeight * 0.35, [0, 0, 4, 4]);
    ctx.fill();
  }

  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < numBars; i++) {
    if (peaks[i] > 3) {
      ctx.beginPath();
      ctx.roundRect(i * barSpacing + (barSpacing - barWidth) / 2, baseLine - peaks[i] - 4, barWidth, 3, 2);
      ctx.fill();
    }
  }
}