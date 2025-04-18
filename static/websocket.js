import { updateStatus } from "./core.js";
import { updatePeersList } from "./ui.js";
import { initializePeerConnection, handleSignal } from "./peer.js";
import { handleFileList, updateFileList } from "./file_transfer.js";

export function initWebSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Connected to server via WebSocket');
        // Join room
        socket.emit('join_room', {
            room_id: roomId,
            peer_id: sessionStorage.getItem('peerId')
        });
    });

    socket.on('registered', (data) => {
        myPeerId = data.peer_id;
        sessionStorage.setItem('peerId', myPeerId);
        console.log("Registered with peer ID:", myPeerId);
        updateStatus(`Your peer ID: ${myPeerId}`);
        updatePeersList(data.peers);
    });

    socket.on('room_peers', (data) => {
        console.log("Room peers:", data.peers);
        if (!myPeerId && data.peers.length==1){
            myPeerId = data.peers[0];
        }
        updatePeersList(data.peers);
        // Initiate connections to other peers
        setTimeout(() => {
            // Initiate connections to other peers - but only if we're not already connected
            data.peers.forEach(peerId => {
                if (peerId !== myPeerId) {
                    if (!peers[peerId] || peers[peerId].state!== CONNECTION_STATES.CONNECTED) {
                        console.log(`Initiating connection to peer ${peerId} from room_peers event`);
                        initializePeerConnection(peerId);
                    } else {
                        console.log(`Already connected to peer ${peerId}`);
                    }
                }
            });
        }, 0);
    });

    socket.on('peer_joined', (data) => {
        console.log("Peer joined:", data.peer_id);
        if (data.peer_id !== myPeerId && !peers[data.peer_id]) {
            initializePeerConnection(data.peer_id);
        }
        // Send file list to new peer
        broadcastFileList();
    });

    socket.on('peer_disconnected', (data) => {
        console.log("Peer disconnected:", data.peer_id);
        if (peers[data.peer_id]) {
            peers[data.peer_id].connection.destroy();
            delete peers[data.peer_id];
        }
        updatePeersList();
    });

    socket.on('signal', (data) => {
        handleSignal(data);
    });

    socket.on('file_list', (data) => {
        console.log("Received file list from server:", data);
        if (data.from && data.from !== myPeerId) {
            handleFileList(data.from, data.files);
        }
    });

    socket.on('active_peers', (data) => {
        updatePeersList(data.peers);
    });

    socket.on('error', (data) => {
        console.error("Socket error:", data.message);
        updateStatus(`Error: ${data.message}`);
    });

    // Send heartbeat every 5 seconds
    setInterval(() => {
        socket.emit('heartbeat', {
            room_id: roomId,
            peer_id: myPeerId
        });
    }, 5000);
}

export function sendSignal(peerId, signalData) {
    console.log(`Sending signal to peer: ${peerId}`);
    socket.emit('signal', {
        room_id: roomId,
        from: myPeerId,
        to: peerId,
        signal: signalData
    });
}

export function broadcastFileList() {
    const fileList = Object.keys(files).map(fileId => {
        const file = files[fileId];
        // Calculate size for different file types
        let size = 0;
        if (file.size !== undefined) {
            // Regular File object
            size = file.size;
        } else if (file.chunks) {
            // Reconstructed file from chunks
            size = file.chunks.reduce((total, chunk) => total + (chunk ? chunk.byteLength : 0), 0);
        }

        return {
            fileId: fileId,
            fileName: file.name,
            size: size
        };
    });

    // Send to server/all peers
    socket.emit('file_list', {
        room_id: roomId,
        from: myPeerId,
        files: fileList
    });

    // Also update our own file list UI
    updateFileList();
}
