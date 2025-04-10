// Core functionality
import { init, updateStatus } from './core.js';

// UI related functions
import { 
    addFileToUI, 
    showToast, 
    updateFileDownloadStatus,
    updatePeersList 
} from './ui.js';

// WebSocket related functions
import { 
    broadcastFileList, 
    initWebSocket, 
    sendSignal 
} from './websocket.js';

// Peer connection related functions
import {  
    handleSignal, 
    initializePeerConnection 
} from './peer.js';

// File transfer related functions
import { 
    handleFiles, 
    handleFileList, 
    handleFileData, 
    handleFileRequest,
    requestFileFromPeer,
    sendFileList,
    sendFileToPeer,
    updateFileList
} from './file_transfer.js';
      
window.addEventListener('load', init);
console.log("Initialization complete.");