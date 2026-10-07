/**
 * "What should we call you?" prompt shown when someone goes live or joins a stage.
 * The answer is saved in the singer profile (localStorage), so it is only asked once; after
 * that the saved name is reused everywhere (lobby, invites, chat, LiveKit participant name).
 */

let activePrompt = null;

/**
 * @param {import('./presence-manager.js').PresenceManager} presence
 * @param {{title?: string, subtitle?: string, confirmLabel?: string}} [opts]
 * @returns {Promise<string>} the name to use (the saved one, a new one, or the current default if skipped)
 */
export function ensureSingerName(presence, opts = {}) {
  if (!presence) return Promise.resolve('Singer');
  if (presence.hasChosenName()) return Promise.resolve(presence.user.name);
  if (activePrompt) return activePrompt; // several actions can ask at once; show one dialog

  activePrompt = new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'singerNamePrompt';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(4,2,8,0.85);display:flex;align-items:center;justify-content:center;padding:20px;';

    const card = document.createElement('div');
    card.style.cssText = 'background:linear-gradient(145deg,#1c152b,#0f0b18);border:1px solid #ff007f;border-radius:20px;padding:26px 22px;max-width:380px;width:100%;box-shadow:0 0 35px rgba(255,0,127,0.35);text-align:center;color:#fff;font-family:inherit;';

    const emoji = document.createElement('div');
    emoji.textContent = presence.user.avatar || '🎤';
    emoji.style.cssText = 'font-size:2.6rem;margin-bottom:8px;';

    const h = document.createElement('h2');
    h.textContent = opts.title || 'What should we call you?';
    h.style.cssText = 'font-size:1.2rem;font-weight:800;margin:0 0 6px;';

    const p = document.createElement('p');
    p.textContent = opts.subtitle || 'Your name is shown to your audience and to singers you invite. It is saved on this device, so you only enter it once.';
    p.style.cssText = 'font-size:0.85rem;line-height:1.45;margin:0 0 16px;color:#a39cb5;';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 24;
    input.placeholder = 'Your singer name';
    input.autocomplete = 'nickname';
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);color:#fff;font-size:1rem;margin-bottom:14px;outline:none;';

    const err = document.createElement('div');
    err.style.cssText = 'color:#ff6b8a;font-size:0.78rem;min-height:1.1em;margin:-8px 0 8px;';

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = opts.confirmLabel || 'Continue';
    ok.style.cssText = 'width:100%;min-height:46px;font-size:0.95rem;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#ff007f,#9b51e0);border:none;border-radius:12px;color:#fff;';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.textContent = `Skip, use "${presence.user.name}"`;
    skip.style.cssText = 'width:100%;min-height:38px;margin-top:8px;font-size:0.8rem;cursor:pointer;background:transparent;border:none;color:#a39cb5;';

    card.append(emoji, h, p, input, err, ok, skip);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);

    const finish = (name) => {
      overlay.remove();
      activePrompt = null;
      resolve(name);
    };

    const submit = () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (name.length < 2) {
        err.textContent = 'Please enter at least 2 characters.';
        input.focus();
        return;
      }
      presence.updateProfile(name); // saves to localStorage and marks the name as chosen
      finish(presence.user.name);
    };

    ok.addEventListener('click', submit);
    skip.addEventListener('click', () => finish(presence.user.name)); // not marked as chosen: asked again next time
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') finish(presence.user.name);
    });
  });

  return activePrompt;
}
