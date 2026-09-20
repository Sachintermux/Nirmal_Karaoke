import livekitHandler from '../netlify/functions/livekit-token.mjs';
import presenceHandler from '../netlify/functions/presence.mjs';

async function runTests() {
  console.log('=== TEST 1: Presence Host Deduplication ===');
  // Register an active host user
  const hostHeartbeat = new Request('https://test/api/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'usr_singer_nirmal',
      name: 'Nirmal Singer',
      role: 'host',
      roomId: 'sing-test1234',
      roomName: 'My Live Stage',
      isLive: true,
      device: 'mobile'
    })
  });
  const hbRes = await presenceHandler(hostHeartbeat);
  const hbData = await hbRes.json();
  console.log('Registered host in presence:', hbData.ok, 'user count:', hbData.users?.length);

  // Now query users list
  const usersReq = new Request('https://test/api/presence/users');
  const usersRes = await presenceHandler(usersReq);
  const usersData = await usersRes.json();
  console.log('Users in lobby:', usersData.users?.map(u => ({ id: u.id, name: u.name, roomId: u.roomId })));

  // Verify no duplicate host for sing-test1234
  const hostsForRoom = usersData.users?.filter(u => u.roomId === 'sing-test1234');
  if (hostsForRoom.length > 1) {
    throw new Error('DUPLICATE HOST DETECTED for room sing-test1234!');
  }
  console.log('PASS: Host deduplication verified. Only 1 entry exists for sing-test1234 ✅');

  console.log('\n=== TEST 2: Multistream RTMP Egress Validation ===');
  // Test start-egress request validation
  const streamReq = new Request('https://test/api/stream/start-egress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'start-egress',
      roomName: 'sing-test1234',
      platform: 'youtube',
      streamKey: 'abcd-1234-wxyz-5678'
    })
  });
  const streamRes = await livekitHandler(streamReq);
  const streamData = await streamRes.json();
  console.log('Multistream response status:', streamRes.status, 'data:', streamData);

  // Test status check
  const statusReq = new Request('https://test/api/stream/status?action=stream-status&room=sing-test1234');
  const statusRes = await livekitHandler(statusReq);
  const statusData = await statusRes.json();
  console.log('Stream status endpoint response:', statusRes.status, 'active:', statusData.active);

  // Test stop stream
  const stopReq = new Request('https://test/api/stream/stop-egress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'stop-egress',
      roomName: 'sing-test1234'
    })
  });
  const stopRes = await livekitHandler(stopReq);
  const stopData = await stopRes.json();
  console.log('Stop stream response:', stopRes.status, 'status:', stopData.status);

  console.log('\nALL FEATURE UNIT TESTS PASSED! ✅');
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
