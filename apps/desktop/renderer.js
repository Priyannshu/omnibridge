// renderer.js — uses window.omnibridgeAPI exposed by preload.js
// contextIsolation:true means require('electron') is NOT available here.
const api = window.omnibridgeAPI;

let receivedFilePath = null;

// ── WebSocket / Connection Status Badge ──
api.onWsStatus((status) => {
    const indicator = document.getElementById('statusIndicator');
    if (status === 'connected') {
        indicator.classList.add('active');
        indicator.innerHTML = '<span class="status-dot"></span> SERVER CONNECTED';
    } else if (status === 'error' || status === 'disconnected') {
        indicator.classList.remove('active');
        indicator.innerHTML = '<span class="status-dot"></span> DISCOVERY ACTIVE';
    }
});

api.onConnectionStatus((data) => {
    const indicator = document.getElementById('statusIndicator');
    if (data.status === 'connected' || data.status === 'connecting') {
        indicator.classList.add('active');
        indicator.innerHTML = `<span class="status-dot"></span> ${data.status === 'connected' ? 'CONNECTION SECURED' : 'CONNECTING...'}`;
    }
});

// ── Device Discovery ──
api.onDeviceFound((device) => {
    const grid = document.getElementById('deviceGrid');
    const empty = grid.querySelector('.empty-state');
    if (empty) empty.remove();

    if (document.getElementById(`device-${device.name}`)) return;

    const card = document.createElement('div');
    card.className = 'device-card-pro';
    card.id = `device-${device.name}`;
    card.innerHTML = `
        <div class="card-inner">
            <div class="item-icon">🖥️</div>
            <div class="item-meta">
                <h4>${device.name}</h4>
                <p>${device.host}</p>
            </div>
            <button class="conn-btn" data-device="${device.name}">CONNECT</button>
        </div>
    `;
    card.querySelector('.conn-btn').addEventListener('click', () => {
        api.connectToDevice(device.name);
        const btn = card.querySelector('.conn-btn');
        btn.textContent = 'LINKING...';
        btn.classList.add('connected');
        btn.disabled = true;
    });
    grid.appendChild(card);
    document.getElementById('deviceCount').textContent = `${grid.querySelectorAll('.device-card-pro').length} Found`;
});

// ── Bridge Engine — INITIALIZE ENGINE button ──
document.getElementById('btnRun').addEventListener('click', () => {
    api.initializeBridge();
});

api.onBridgeStatus((status) => {
    const btn = document.getElementById('btnRun');
    btn.textContent = 'ENGINE ACTIVE';
    btn.classList.add('active');
    btn.disabled = true;
});

// ── System Switch (cursor crossed edge) ──
api.onSystemSwitched((system) => {
    const label = document.getElementById('activeSystemLabel');
    const icon  = document.getElementById('statusIcon');
    const info  = document.getElementById('captureInfo');

    if (system === 'remote') {
        label.textContent = 'REMOTE OVERRIDE';
        icon.textContent  = '🖥️';
        icon.classList.add('override');
        info.textContent  = 'Capture active';
        document.body.classList.add('capture-active');
    } else {
        label.textContent = 'LOCAL SYSTEM';
        icon.textContent  = '💻';
        icon.classList.remove('override');
        info.textContent  = 'Ready to bridge';
        document.body.classList.remove('capture-active');
    }
});

// ── File Transfer ──
const dropZone     = document.getElementById('dropZone');
const fileStatus   = document.getElementById('fileStatus');
const ghost        = document.getElementById('ghostFile');
const progContainer = document.getElementById('progressContainer');
const progFill     = document.getElementById('progressFill');
const progText     = document.getElementById('progressText');

dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('active'); });
dropZone.addEventListener('dragleave', ()  => { dropZone.classList.remove('active'); });
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('active');
    if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        fileStatus.textContent = `SENDING: ${file.name.toUpperCase()}`;
        api.sendFile(file.path);
    }
});

api.onFileProgress(({ fileName, progress, type }) => {
    progContainer.style.display = 'block';
    progText.style.display = 'block';
    const pct = Math.round(progress * 100);
    progFill.style.width = pct + '%';
    progText.textContent = `${type === 'send' ? 'SENDING' : 'RECEIVING'}: ${pct}%`;
});

api.onFileReceived(({ name, path }) => {
    receivedFilePath = path;
    document.getElementById('ghostFileName').textContent = name;
    ghost.style.display = 'flex';
    fileStatus.innerHTML = `<span style="color:#00ff88">RECEIVED: ${name.toUpperCase()}</span>`;
    setTimeout(() => {
        progContainer.style.display = 'none';
        progText.style.display = 'none';
        progFill.style.width = '0%';
    }, 2000);
});

// Native drag from ghost icon
ghost.addEventListener('mousedown', () => {
    if (receivedFilePath) {
        api.startNativeDrag(receivedFilePath);
        setTimeout(() => { ghost.style.display = 'none'; }, 100);
    }
});

window.addEventListener('mousemove', (e) => {
    if (ghost.style.display === 'flex') {
        ghost.style.left = (e.clientX + 15) + 'px';
        ghost.style.top  = (e.clientY + 15) + 'px';
    }
});

// ── System Mode Selector (Auto / Manual IP) ──
document.getElementById('btnAuto').addEventListener('click', () => {
    document.getElementById('btnAuto').classList.add('active');
    document.getElementById('btnManual').classList.remove('active');
    document.getElementById('manualIpInput').style.display = 'none';
});

document.getElementById('btnManual').addEventListener('click', () => {
    document.getElementById('btnManual').classList.add('active');
    document.getElementById('btnAuto').classList.remove('active');
    document.getElementById('manualIpInput').style.display = 'block';
    document.getElementById('ipAddress').focus();
});

// ── Manual IP Connect ──
function manualConnect() {
    const input  = document.getElementById('ipAddress');
    const ip     = input.value.trim();
    const btn    = document.getElementById('btnConnectIp');
    const status = document.getElementById('manualConnectStatus');

    if (!ip) {
        input.style.borderColor = '#ff4444';
        input.placeholder = 'Enter an IP address first!';
        return;
    }

    // Basic IP validation (accepts both IP and Tailscale 100.x.x.x range)
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) {
        input.style.borderColor = '#ff4444';
        status.textContent = '✗ Invalid IP format';
        status.style.color = '#ff4444';
        return;
    }

    input.style.borderColor = 'rgba(255,255,255,0.1)';
    btn.textContent = 'CONNECTING...';
    btn.disabled = true;
    status.textContent = `⟳ Connecting to ${ip}...`;
    status.style.color = '#888';

    api.manualConnect(ip);
}

// Allow pressing Enter in the IP field to connect
document.getElementById('ipAddress').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') manualConnect();
});

// ── Clipboard Sharing ──
document.getElementById('clipboardToggle').addEventListener('change', (e) => {
    if (e.target.checked) {
        api.startClipboardSharing();
    } else {
        api.stopClipboardSharing();
    }
});

// ── Connection Approval ──
api.onConnectionRequestPending((data) => {
    // Auto-approve for now — TODO: show a proper modal
    console.log('Connection request from:', data.deviceInfo);
    api.approveConnection(data.requestingClientId);
});

// Update manual connect button feedback when connection status changes
api.onConnectionStatus((data) => {
    const btn    = document.getElementById('btnConnectIp');
    const status = document.getElementById('manualConnectStatus');
    if (!btn || !status) return;

    if (data.status === 'connected') {
        btn.textContent = 'CONNECTED ✓';
        btn.style.background = '#00c853';
        status.textContent = `✓ Connected to ${data.device}`;
        status.style.color = '#00ff88';
    } else if (data.status === 'connecting') {
        btn.textContent = 'CONNECTING...';
        status.textContent = `⟳ Connecting to ${data.device}...`;
        status.style.color = '#888';
    }
});