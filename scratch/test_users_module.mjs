
    import { PresenceManager } from './js/presence-manager.js?v=24';

    const presence = new PresenceManager();

    const singersList = document.getElementById('singersList');
    const lblOnlineCount = document.getElementById('lblOnlineCount');
    const myAvatar = document.getElementById('myAvatar');
    const myName = document.getElementById('myName');
    const myStatus = document.getElementById('myStatus');
    const btnEditName = document.getElementById('btnEditName');
    const searchInput = document.getElementById('searchInput');
    const btnRefreshList = document.getElementById('btnRefreshList');
    const filterBtns = document.querySelectorAll('.filter-btn');

    let currentFilter = 'all';
    let currentQuery = '';
    const pendingInvitedUsers = new Set();

    const myActiveStageWrap = document.getElementById('myActiveStageWrap');

    // Render my profile & active stage
    function updateMyProfileUI() {
        if (myAvatar) myAvatar.textContent = presence.user.avatar || '🎤';
        if (myName) myName.textContent = presence.user.name || 'Singer';

        if (myActiveStageWrap) {
            if (presence.isLive && presence.currentRoomId) {
                myActiveStageWrap.innerHTML = `
                    <div class="my-stage-card">
                        <div class="my-stage-info">
                            <span class="live-dot-pulse"></span>
                            <div>
                                <div class="my-stage-title">👑 Your Live Broadcast Stage</div>
                                <div class="my-stage-sub">Room: <b>${escapeHtml(presence.currentRoomName || presence.currentRoomId)}</b> • LiveKit SFU</div>
                            </div>
                        </div>
                        <div class="my-stage-actions">
                            <a href="./index.html" class="btn-stage-return">🎙️ Studio</a>
                            <a href="./audience.html?room=${encodeURIComponent(presence.currentRoomId)}&role=audience" target="_blank" class="btn-stage-view">👁️ View Stream</a>
                        </div>
                    </div>
                `;
            } else {
                myActiveStageWrap.innerHTML = '';
            }
        }
    }

    updateMyProfileUI();

    // Interactive avatar picker grid popover
    let usersAvatarPopover = null;
    const avatars = ['🎤', '🎧', '🎸', '🎹', '⚡', '👑', '🔥', '🌟', '🎶', '💎', '🚀', '🐱'];
    myAvatar?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (usersAvatarPopover) {
            usersAvatarPopover.remove();
            usersAvatarPopover = null;
            return;
        }
        usersAvatarPopover = document.createElement('div');
        usersAvatarPopover.style.cssText = 'position:absolute; top:45px; left:0; z-index:300; background:#1c162b; border:1px solid rgba(0,229,255,0.4); border-radius:12px; padding:8px; display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; box-shadow:0 8px 30px rgba(0,0,0,0.8);';
        avatars.forEach((av) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = av;
            btn.style.cssText = 'background:rgba(255,255,255,0.06); border:1px solid var(--border); border-radius:8px; font-size:1.3rem; padding:6px; cursor:pointer; transition:all 0.15s;';
            if (av === presence.user.avatar) {
                btn.style.borderColor = '#00e5ff';
                btn.style.background = 'rgba(0,229,255,0.2)';
            }
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                presence.updateProfile(presence.user.name, av);
                updateMyProfileUI();
                usersAvatarPopover?.remove();
                usersAvatarPopover = null;
            });
            usersAvatarPopover.appendChild(btn);
        });
        if (myAvatar.parentElement) {
            myAvatar.parentElement.style.position = 'relative';
            myAvatar.parentElement.appendChild(usersAvatarPopover);
        }
        const closeOnOutside = (ev) => {
            if (usersAvatarPopover && !usersAvatarPopover.contains(ev.target)) {
                usersAvatarPopover.remove();
                usersAvatarPopover = null;
                document.removeEventListener('click', closeOnOutside);
            }
        };
        setTimeout(() => document.addEventListener('click', closeOnOutside), 50);
    });

    // Edit Name
    btnEditName?.addEventListener('click', () => {
        const newName = prompt('Enter your singer name / nickname:', presence.user.name);
        if (newName && newName.trim()) {
            presence.updateProfile(newName.trim(), presence.user.avatar);
            updateMyProfileUI();
        }
    });

    // Render user roster
    function renderRoster(users) {
        if (!singersList) return;

        // Filter out myself and my own active live stage
        let list = users.filter(u => {
            if (u.id === presence.user.id) return false;
            if (presence.currentRoomId && (u.roomId === presence.currentRoomId || u.id === `host_${presence.currentRoomId}`)) return false;
            return true;
        });

        if (lblOnlineCount) {
            lblOnlineCount.textContent = `${users.length} Online`;
        }

        // Apply search query
        if (currentQuery) {
            const q = currentQuery.toLowerCase();
            list = list.filter(u => u.name.toLowerCase().includes(q));
        }

        // Apply filter tab
        if (currentFilter === 'live') {
            list = list.filter(u => u.isLive || u.role === 'host');
        } else if (currentFilter === 'idle') {
            list = list.filter(u => !u.isLive && u.role !== 'host');
        }

        if (list.length === 0) {
            singersList.innerHTML = `
                <div class="empty-roster">
                    <div class="icon">👥</div>
                    <p>${currentQuery ? 'No singers match your search.' : 'No other singers online right now.<br>Open Nirmal Karaoke in another tab to test invitations!'}</p>
                </div>
            `;
            return;
        }

        singersList.innerHTML = '';
        list.forEach(u => {
            const card = document.createElement('div');
            card.className = 'singer-card';

            const isLive = !!u.isLive || u.role === 'host';
            const inDuet = u.role === 'duet';
            const avatarClass = isLive ? 'live' : (inDuet ? 'duet' : 'idle');
            const deviceIcon = u.device === 'mobile' ? '📱' : '💻';

            let statusText = '🟢 Available to Sing';
            let statusClass = 'idle';
            if (isLive) {
                statusText = `🔴 LIVE • ${u.roomName || 'Karaoke Stage'}`;
                statusClass = 'live';
            } else if (inDuet) {
                statusText = `🎶 In Duet • ${u.roomName || 'Duet Stage'}`;
                statusClass = 'duet';
            }

            const isInvited = pendingInvitedUsers.has(u.id);

            card.innerHTML = `
                <div class="singer-left">
                    <div class="singer-avatar-wrap">
                        <div class="singer-avatar ${avatarClass}">${u.avatar || '🎤'}</div>
                        <span class="device-badge">${deviceIcon}</span>
                    </div>
                    <div class="singer-details">
                        <div class="singer-name">
                            <span>${escapeHtml(u.name)}</span>
                        </div>
                        <div class="singer-status-line ${statusClass}">${statusText}</div>
                    </div>
                </div>
                <div class="singer-right">
                    ${isLive && u.roomId ? `
                        <div class="stage-join-actions">
                            <a href="./audience.html?room=${encodeURIComponent(u.roomId)}&role=audience&autoJoin=1" class="btn-action-watch" title="Watch broadcast as audience">👁️ Watch</a>
                            <a href="./audience.html?room=${encodeURIComponent(u.roomId)}&role=duet&autoJoin=1" class="btn-action-join" title="Join live stage with microphone to sing duet">🎤 Duet</a>
                        </div>
                    ` : (isInvited ? `
                        <span class="btn-action-invited">⏳ Invited...</span>
                    ` : `
                        <button class="btn-action-invite" data-user-id="${u.id}">📩 Invite Duet</button>
                    `)}
                </div>
            `;

            const btnInvite = card.querySelector('.btn-action-invite');
            if (btnInvite) {
                btnInvite.addEventListener('click', async () => {
                    btnInvite.disabled = true;
                    btnInvite.textContent = 'Sending...';
                    try {
                        await presence.sendInvite(u.id, 'duet');
                        pendingInvitedUsers.add(u.id);
                        renderRoster(presence.onlineUsers);
                    } catch (err) {
                        alert('Could not send invite: ' + (err.message || 'User offline'));
                        btnInvite.disabled = false;
                        btnInvite.textContent = '📩 Invite Duet';
                    }
                });
            }

            singersList.appendChild(card);
        });
    }

    // Subscribe to SSE updates
    presence.onUserListUpdated = (users) => {
        renderRoster(users);
    };

    // Handle invite response (accepted/declined)
    presence.onInviteResponse = (res) => {
        if (res.accepted) {
            alert(`🎉 ${res.responder?.name || 'Singer'} accepted your Duet invite! Connecting...`);
            if (typeof window !== 'undefined') window.__bypassUnloadWarning = true;
            const targetRoom = res.roomId || presence.currentRoomId;
            if (targetRoom) {
                if (presence.isLive && presence.currentRole === 'host') {
                    window.location.href = `./index.html#stage`;
                } else {
                    window.location.href = `./audience.html?room=${encodeURIComponent(targetRoom)}&role=duet&autoJoin=1`;
                }
            }
        } else {
            pendingInvitedUsers.delete(res.responder?.id);
            renderRoster(presence.onlineUsers);
        }
    };

    // Filter clicks
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.getAttribute('data-filter');
            renderRoster(presence.onlineUsers);
        });
    });

    // Search input
    searchInput?.addEventListener('input', (e) => {
        currentQuery = e.target.value.trim();
        renderRoster(presence.onlineUsers);
    });

    // Refresh button
    btnRefreshList?.addEventListener('click', async () => {
        try {
            const r = await fetch('/api/presence/users');
            const data = await r.json();
            if (data?.users) {
                presence.onlineUsers = data.users;
                renderRoster(data.users);
            }
        } catch (_) {}
    });

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
