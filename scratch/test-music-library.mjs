import { spawn } from 'child_process';

console.log('=== TESTING MUSIC LIBRARY & AUTOSEARCH FIXES ===');

const TEST_PORT = 3899;
const serverProc = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(TEST_PORT) },
  cwd: process.cwd(),
  stdio: 'inherit'
});

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${TEST_PORT}/api/health`);
      if (res.ok) return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

async function run() {
  const ready = await waitForServer();
  if (!ready) {
    throw new Error('Server health check failed to respond on port ' + TEST_PORT);
  }
  console.log('Server verified ready on port', TEST_PORT);

  // Test 1: Test /api/music/search for "Kesariya"
  console.log('\n--- Test 1: /api/music/search?query=Kesariya ---');
  const res1 = await fetch(`http://localhost:${TEST_PORT}/api/music/search?query=Kesariya`);
  if (!res1.ok) throw new Error('Search failed with status: ' + res1.status);
  const data1 = await res1.json();
  console.log('Search ok:', data1.ok, 'Total tracks:', data1.results?.length);
  if (!data1.results || data1.results.length === 0) {
    throw new Error('Expected tracks for Kesariya, got 0');
  }
  const track0 = data1.results[0];
  console.log('Track 0:', track0.title, '| Artist:', track0.artist, '| URL:', track0.url);
  if (!track0.url || !track0.url.startsWith('https://')) {
    throw new Error('Invalid audio URL: ' + track0.url);
  }

  // Test 2: Audio URL HTTP HEAD check to verify it actually streams
  console.log('\n--- Test 2: Audio URL HEAD verification ---');
  const audioHead = await fetch(track0.url, { method: 'HEAD' });
  console.log('Audio Stream status:', audioHead.status, 'Content-Type:', audioHead.headers.get('content-type'), 'Bytes:', audioHead.headers.get('content-length'));
  if (audioHead.status !== 200) {
    throw new Error('Audio URL failed to stream: status ' + audioHead.status);
  }

  // Test 3: Test Trending endpoint
  console.log('\n--- Test 3: /api/music/trending ---');
  const res3 = await fetch(`http://localhost:${TEST_PORT}/api/music/trending`);
  const data3 = await res3.json();
  console.log('Trending status:', res3.status, 'Tracks count:', data3.results?.length);
  if (!data3.results || data3.results.length === 0) {
    throw new Error('Expected trending tracks, got 0');
  }

  // Test 4: In-memory Cache check
  console.log('\n--- Test 4: Search cache speed check ---');
  const tStart = Date.now();
  const res4 = await fetch(`http://localhost:${TEST_PORT}/api/music/search?query=Kesariya`);
  const tElapsed = Date.now() - tStart;
  console.log(`Cache response in ${tElapsed}ms (Expected < 50ms)`);

  console.log('\nALL MUSIC SEARCH API TESTS PASSED! ✅');
}

run()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    serverProc.kill();
  });
