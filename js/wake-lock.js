/**
 * Screen Wake Lock Manager for Nirmal Karaoke
 * Keeps display awake during live broadcasting, singing, and stage listening.
 * Automatically reacquires lock when returning from background.
 */

let wakeLock = null;
let isRequested = false;

export async function acquireWakeLock() {
  isRequested = true;
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
        console.info('[WakeLock] Screen wake lock acquired. Display sleep prevented during live broadcast.');
      }
    } catch (err) {
      console.warn('[WakeLock] Could not acquire screen wake lock:', err?.message || err);
    }
  }
}

export async function releaseWakeLock() {
  isRequested = false;
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (_) {}
    wakeLock = null;
    console.info('[WakeLock] Screen wake lock released.');
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (isRequested && document.visibilityState === 'visible' && !wakeLock) {
      acquireWakeLock();
    }
  });
}
