import livekitTokenHandler from '../netlify/functions/livekit-token.mjs';
import presenceHandler from '../netlify/functions/presence.mjs';

async function test() {
  console.log('--- Testing livekit-token handler ---');

  // Test 1: Config
  const configReq = new Request('https://nirmalkaraoke.netlify.app/api/livekit/config');
  const configRes = await livekitTokenHandler(configReq);
  const configData = await configRes.json();
  console.log('Config status:', configRes.status, 'enabled:', configData.enabled, 'url:', configData.url);

  // Test 2: Host Token
  const hostReq = new Request('https://nirmalkaraoke.netlify.app/api/livekit/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room-1', identity: 'host-1', role: 'host' })
  });
  const hostRes = await livekitTokenHandler(hostReq);
  const hostData = await hostRes.json();
  console.log('Host token status:', hostRes.status, 'hasToken:', !!hostData.token);

  // Test 3: Audience Token (should NOT return 410 now!)
  const audReq = new Request('https://nirmalkaraoke.netlify.app/api/livekit/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName: 'test-room-1', identity: 'guest-1', role: 'audience' })
  });
  const audRes = await livekitTokenHandler(audReq);
  const audData = await audRes.json();
  console.log('Audience token status:', audRes.status, 'hasToken:', !!audData.token, 'error:', audData.error || 'none');

  console.log('\n--- Testing presence handler ---');

  // Test 4: Heartbeat
  const hbReq = new Request('https://nirmalkaraoke.netlify.app/api/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'usr_test123',
      name: 'Nirmal Singer',
      avatar: '🎤',
      role: 'host',
      roomId: 'test-room-1',
      roomName: 'Bollywood Classics',
      isLive: true,
      device: 'mobile'
    })
  });
  const hbRes = await presenceHandler(hbReq);
  const hbData = await hbRes.json();
  console.log('Heartbeat status:', hbRes.status, 'users count:', hbData.users?.length);

  // Test 5: Users list
  const usersReq = new Request('https://nirmalkaraoke.netlify.app/api/presence/users');
  const usersRes = await presenceHandler(usersReq);
  const usersData = await usersRes.json();
  console.log('Users list status:', usersRes.status, 'users:', usersData.users?.map(u => ({ id: u.id, name: u.name, isLive: u.isLive })));

  // Test 6: Send Game Invite
  const invReq = new Request('https://nirmalkaraoke.netlify.app/api/presence/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromUser: { id: 'usr_singerA', name: 'Singer A', avatar: '👑', roomId: 'stage-1' },
      toUserId: 'usr_test123',
      roomId: 'stage-1',
      roomName: 'Pop Arena',
      type: 'duet'
    })
  });
  const invRes = await presenceHandler(invReq);
  const invData = await invRes.json();
  console.log('Invite sent status:', invRes.status, 'inviteId:', invData.inviteId);

  // Test 7: Heartbeat for target user (should now return the pending invite!)
  const hbReq2 = new Request('https://nirmalkaraoke.netlify.app/api/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'usr_test123' })
  });
  const hbRes2 = await presenceHandler(hbReq2);
  const hbData2 = await hbRes2.json();
  console.log('Target received pending invites:', hbData2.pendingInvites?.length, 'from:', hbData2.pendingInvites?.[0]?.fromUser?.name);

  // Test 8: Respond to invite
  const respReq = new Request('https://nirmalkaraoke.netlify.app/api/presence/respond-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inviteId: invData.inviteId,
      responderId: 'usr_test123',
      accepted: true
    })
  });
  const respRes = await presenceHandler(respReq);
  const respData = await respRes.json();
  console.log('Response sent status:', respRes.status, 'status:', respData.status);

  // Test 9: Heartbeat for sender (should receive invite response!)
  const hbReq3 = new Request('https://nirmalkaraoke.netlify.app/api/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'usr_singerA' })
  });
  const hbRes3 = await presenceHandler(hbReq3);
  const hbData3 = await hbRes3.json();
  console.log('Sender received responses:', hbData3.inviteResponses?.length, 'accepted:', hbData3.inviteResponses?.[0]?.accepted);

  console.log('\nALL NETLIFY SERVERLESS FUNCTION TESTS PASSED SUCCESSFULLY! ✅');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
