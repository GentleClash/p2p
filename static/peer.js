import { updateStatus } from "./core.js";
import { sendSignal } from "./websocket.js";
import { showToast, updatePeersList } from "./ui.js";
import { handleFileData, handleFileList, handleFileRequest, sendFileList} from "./file_transfer.js";

export function initializePeerConnection(peerId) {
    if (peers[peerId] && (peers[peerId].connection || peers[peerId].connectionState === 'connected')) {
        console.log(`Connection with peer ${peerId} already exists`);
        return peers[peerId].connection;
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
        connectionAttempts: 0,
        lastConnectionAttempt: Date.now(),
        connected: false
    };

    // Handle peer events
    peer.on('signal', (data) => {
        console.log(`Signal generated for peer: ${peerId}`, data);
        // Send signaling data to the other peer via server
        sendSignal(peerId, data);
    });

    peer.on('connect', () => {
        console.log(`Connected to peer: ${peerId}`);
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
        delete peers[peerId];
        updatePeersList();
    });
}

export function handleSignal(signal) {
    if (!signal || !signal.from || !signal.signal) {
        console.error("Received invalid signal data", signal);
        return;
    }

    const fromPeerId = signal.from;
    const signalData = signal.signal; // Handle different formats

    console.log(`Received signal from peer: ${fromPeerId}`, signalData);

    // If we don't have a connection to this peer yet, create one
    if (!peers[fromPeerId]) {
        initializePeerConnection(fromPeerId);
    }

    // Process the signal with simple-peer
    try {
        if (peers[fromPeerId] && peers[fromPeerId].connection) {
            peers[fromPeerId].connection.signal(signalData);
        } else {
            console.error(`Peer ${fromPeerId} not ready for signaling yet`);
        }
    } catch (error) {
        console.error(`Error processing signal from ${fromPeerId}:`, error);
    }
}
