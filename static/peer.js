import { updateStatus } from "./core.js";
import { sendSignal } from "./websocket.js";
import { showToast, updatePeersList } from "./ui.js";
import { handleFileData, handleFileList, handleFileRequest, sendFileList, handleDownloadProgress } from "./file_transfer.js";

export function initializePeerConnection(peerId) {
    if (peers[peerId] && peers[peerId].state === CONNECTION_STATES.CONNECTED) {
        console.log(`Connection with peer ${peerId} already exists`);
        return peers[peerId].connection;
    }
    if (peers[peerId] && peers[peerId].state === CONNECTION_STATES.ERROR) {
        if (peers[peerId].connection) {
            peers[peerId].connection.destroy();
        }
    }
    if (peers[peerId] && peers[peerId].state === CONNECTION_STATES.CONNECTING) {
        console.log(`Connection attempt with peer ${peerId} already in progress`);
        return;
    }

    updateStatus(`Connecting to peer: ${peerId}...`);
    console.log(`Initializing connection with peer: ${peerId}`);

    const peer = new SimplePeer({
        initiator: myPeerId < peerId,
        trickle: true
    });

    peers[peerId] = {
        connection: peer,
        files: [],
        connectionAttempts: peers[peerId] ? peers[peerId].connectionAttempts + 1 : 1,
        lastConnectionAttempt: Date.now(),
        state: CONNECTION_STATES.CONNECTING,
        timeoutTimer: setTimeout(() => handleConnectionTimeout(peerId), 10000)
    };

    // Handle peer events
    peer.on('signal', (data) => {
        console.log(`Signal generated for peer: ${peerId}`, data);
        peers[peerId].state = CONNECTION_STATES.SIGNALING;
        // Send signaling data to the other peer via server
        sendSignal(peerId, data);
    });

    peer.on('connect', () => {
        console.log(`Connected to peer: ${peerId}`);
        clearTimeout(peers[peerId].timeoutTimer);
        peers[peerId].state = CONNECTION_STATES.CONNECTED;
        updateStatus(`Connected to peer: ${peerId}`);
        showToast(`Connected to peer: ${peerId}`);
        peers[peerId].connected = true;
        // Send file list to new peer
        sendFileList(peer);
    });

    peer.on('data', async (data) => {
        // Convert buffer to string if needed
        let isJSON = false;
        let jsonStr = '';

        if (typeof data === 'string') {
            jsonStr = data;
            isJSON = true;
        } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            try {
                const text = new TextDecoder().decode(data);
                if (text.trim().startsWith('{') && text.includes('"type":')) {
                    jsonStr = text;
                    isJSON = true;
                }
            } catch (_) {
                isJSON = false;
            }
        }

        if (isJSON) {
            try {
                // The message was [JSON, separator (0x00), binary data]
                const separatorIndex = jsonStr.indexOf('\u0000');
                if (separatorIndex !== -1) {
                    jsonStr = jsonStr.slice(0, separatorIndex);
                }
                const parsed = JSON.parse(jsonStr);
                switch (parsed.type) {
                    case 'file-list':
                        handleFileList(peerId, parsed.files);
                        break;
                    case 'file-request':
                        handleFileRequest(peerId, parsed.fileId);
                        break;
                    case 'file-data':
                        const chunkBuffer = new Uint8Array(data.slice(separatorIndex + 1));
                        handleFileData(parsed.fileId, parsed.fileName, chunkBuffer.buffer, parsed.totalChunks, parsed.chunkIndex);
                        break;
                    case 'ping':
                        peer.connection.send(JSON.stringify({ type: 'pong', timestamp: parsed.timestamp }));
                        break;
                    case 'pong':
                        const latency = Date.now() - parsed.timestamp;
                        console.log(`Latency to peer ${peerId}: ${latency}ms`);
                        peers[peerId].lastDataReceived = Date.now();
                    case 'download-progress':
                        handleDownloadProgress(
                            parsed.fileId, 
                            parsed.progress, 
                            parsed.downloaderId, 
                            parsed.completed || false, 
                            parsed.error || null
                        );
                        break;

                    default:
                        console.warn("Unhandled JSON message type:", parsed);
                }
                return;
            } catch (e) {
                console.warn("Failed to parse JSON:", e);
            }
        }
    });


    peer.on('error', (err) => {
        console.error(`Peer connection error with ${peerId}:`, err);
        updateStatus(`Connection error with peer: ${peerId}`);
    });

    peer.on('close', () => {
        console.log(`Connection closed with peer: ${peerId}`);
        updateStatus(`Connection closed with peer: ${peerId}`);
        if (peers[peerId] && peers[peerId].timeoutTimer) {
            clearTimeout(peers[peerId].timeoutTimer);
        }
        if (peers[peerId]) {
            peers[peerId].state = CONNECTION_STATES.DISCONNECTED;
            
            // Only attempt to reconnect if this wasn't a manual disconnect
            if (!peers[peerId].manualDisconnect) {
                // Implement backoff reconnection
                const backoffTime = Math.min(1000 * Math.pow(2, peers[peerId].connectionAttempts), 30000);
                console.log(`Will attempt reconnection in ${backoffTime}ms`);
                
                setTimeout(() => {
                    initializePeerConnection(peerId);
                }, backoffTime);
            } else {
                // Clean up the peer object if this was a manual disconnect
                delete peers[peerId];
            }
        }
        updatePeersList();
    });

    return peer;
}

export function handleSignal(signal) {
    if (!signal || !signal.from || !signal.signal) {
        console.error("Received invalid signal data", signal);
        return;
    }

    const fromPeerId = signal.from;
    const signalData = signal.signal;

    //console.log(`Received signal from peer: ${fromPeerId}`, signalData);
    console.log(`Received signal from peer: ${fromPeerId}`);

    // If we don't have a connection to this peer yet, create one
    if (!peers[fromPeerId]) {
        initializePeerConnection(fromPeerId);
    } else if (peers[fromPeerId].state === CONNECTION_STATES.ERROR) {
        // If the connection was in error state, reinitialize
        initializePeerConnection(fromPeerId);
    }

    // Process the signal with simple-peer
    setTimeout(() => {
    try {
        if (peers[fromPeerId] && peers[fromPeerId].connection) {
            peers[fromPeerId].connection.signal(signalData);
            peers[fromPeerId].lastSignalReceived = Date.now();
        } else {
            console.error(`Peer ${fromPeerId} not ready for signaling yet`);
        }
    } catch (error) {
        console.error(`Error processing signal from ${fromPeerId}:`, error);
        peers[fromPeerId].state = CONNECTION_STATES.ERROR;
    }
}, 0);
}

function handleConnectionTimeout(peerId) {
    if (!peers[peerId] || peers[peerId].state === CONNECTION_STATES.CONNECTED) {
        return;
    }

    console.log(`Connection timeout with peer: ${peerId}`);
    updateStatus(`Connection timeout with peer: ${peerId}`);

    if (peers[peerId].connection) {
        peers[peerId].connection.destroy();
    }

    peers[peerId].state = CONNECTION_STATES.ERROR;

    // Backoff for reconnection attempts
    const maxAttempts = 5;
    if (peers[peerId].connectionAttempts < maxAttempts) {
        const backoffTime = Math.min(1000 * Math.pow(2, peers[peerId].connectionAttempts), 30000);
        console.log(`Will retry connection in ${backoffTime}ms (attempt ${peers[peerId].connectionAttempts})`);

        setTimeout(() => {
            initializePeerConnection(peerId);
        }, backoffTime);
    } else {
        console.log(`Max reconnection attempts reached for peer: ${peerId}`);
        delete peers[peerId];
        updatePeersList();
    }
}