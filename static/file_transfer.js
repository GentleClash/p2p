import { broadcastFileList } from "./websocket.js";
import { updateFileDownloadStatus, showToast, addFileToUI } from "./ui.js";
import { initializePeerConnection } from "./peer.js";



export function handleFiles(newFiles) {
    console.log("Handling files:", newFiles);
    function sanitizeFileName(fileId) {
        return fileId.replace(/[^a-zA-Z0-9._-]/g, '_');
    }
    for (const file of newFiles) {
        //const fileId = `${myPeerId}-${Date.now()}-${file.name}`;
        const fileId = sanitizeFileName(`${myPeerId}-${Date.now()}-${file.name}`);  
        files[fileId] = file;
        addFileToUI(fileId, file.name, URL.createObjectURL(file), file.size);
        broadcastFileList();
    }
}


export function handleFileList(peerId, fileList) {
    console.log(`Received file list from peer ${peerId}:`, fileList);
    const peerFiles = peers[peerId].files;
    fileList.forEach(fileInfo => {
        if (!peerFiles.some(f => f.fileId === fileInfo.fileId)) {
            fileInfo.size = fileInfo.size || 0;
            peerFiles.push(fileInfo);

        }
    });
    updateFileList();
}

export function sendFileList(peer) {
    console.log("Sending file list to peer");

    // A list of files with proper metadata
    const fileList = Object.keys(files).map(fileId => {
        const file = files[fileId];
        return {
            fileId: fileId,
            fileName: file.name,
            size: file.size || (file.chunks ? file.chunks.reduce((total, chunk) => total + (chunk ? chunk.byteLength : 0), 0) : 0)
        };
    });

    // Send the list to the peer
    try {
        const message = JSON.stringify({
            type: 'file-list',
            files: fileList
        });
        peer.send(message);
        console.log(`Sent file list with ${fileList.length} files`);
    } catch (error) {
        console.error("Error sending file list:", error);
    }
}

export function updateFileList() {
    //console.log("Updating file list in UI");
    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '';

    // Check if there are any files to display
    const allFiles = [];

    // Add my own files
    Object.keys(files).forEach(fileId => {
        const fileObj = files[fileId];
        // Only create URL if it's an actual File/Blob object
        let url = null;

        if (fileObj instanceof Blob || fileObj instanceof File) {
            url = URL.createObjectURL(fileObj);
        } else if (fileObj.completeBlob) {
            url = URL.createObjectURL(fileObj.completeBlob);
        } else if (fileObj.completeUrl) {
            url = fileObj.completeUrl;
        }

        allFiles.push({
            fileId: fileId,
            fileName: fileObj.name,
            url: url,
            size: fileObj.size || 0,
            ownedByMe: true
        });
    });

    // Add files from peers
    Object.keys(peers).forEach(peerId => {
        if (peers[peerId].files && peers[peerId].files.length > 0) {
            peers[peerId].files.forEach(fileInfo => {
                // Only add if not already in the list
                if (!allFiles.some(f => f.fileId === fileInfo.fileId)) {
                    allFiles.push({
                        fileId: fileInfo.fileId,
                        fileName: fileInfo.fileName,
                        peerId: peerId,
                        ownedByMe: false,
                        size: fileInfo.size || 0
                    });
                }
            });
        }
    });

    // Display placeholder if no files
    if (allFiles.length === 0) {
        const placeholder = document.createElement('li');
        placeholder.className = 'file-item';
        placeholder.style.justifyContent = 'center';
        placeholder.style.fontStyle = 'italic';
        placeholder.style.color = '#666';
        placeholder.textContent = 'No files shared yet';
        fileList.appendChild(placeholder);
        return;
    }

    // Add files to UI
    allFiles.forEach(fileInfo => {
        if (fileInfo.ownedByMe) {
            addFileToUI(fileInfo.fileId, fileInfo.fileName, fileInfo.url, fileInfo.size, true);
        } else {
            // For peer files that don't have a URL yet
            const listItem = document.createElement('li');
            listItem.className = 'file-item';
            listItem.setAttribute('data-file-id', fileInfo.fileId);

            const fileSize = fileInfo.size ?
                (parseInt(fileInfo.size) / 1024).toFixed(2) + ' KB' : 'Unknown size';

            listItem.innerHTML = `
                        <div class="file-info">
                            <span class="file-name">${fileInfo.fileName}</span>
                            <span class="file-meta">${fileSize}</span>
                            <span class="file-status">Available from peer</span>
                        </div>
                        <button class="download-btn" data-file-id="${fileInfo.fileId}" data-peer-id="${fileInfo.peerId}">Download</button>
                    `;

            // Add click handler to request file
            const downloadBtn = listItem.querySelector('.download-btn');
            downloadBtn.addEventListener('click', () => {
                const fileId = downloadBtn.getAttribute('data-file-id');
                const peerId = downloadBtn.getAttribute('data-peer-id');
                requestFileFromPeer(peerId, fileId);
                downloadBtn.textContent = "Downloading...";
                downloadBtn.disabled = true;
            });

            fileList.appendChild(listItem);
        }
    });
}

export function handleFileRequest(peerId, fileId) {
    console.log(`Peer ${peerId} requested file with ID: ${fileId}`);
    const file = files[fileId];
    if (!file) {
        console.error(`File with ID ${fileId} not found`);
        return;
    }

    console.log(`Preparing to send file: ${file.name}, size: ${file.size} bytes`);

    // Adding a slight delay to ensure connection is stable
    setTimeout(() => {
        sendFileToPeer(peerId, fileId, file);
    }, 500);
}

export function requestFileFromPeer(peerId, fileId) {
    console.log(`Requesting file ${fileId} from peer ${peerId}`);

    // Check if peer exists and has a valid connection
    if (!peers[peerId]) {
        console.error(`Peer ${peerId} not found`);
        showToast(`Connection to peer ${peerId} not established. Try refreshing the page.`);
        return;
    }

    if (!peers[peerId].connection || !peers[peerId].connected) {
        console.error(`No active connection to peer ${peerId}`);
        showToast(`Connection to peer ${peerId} lost. Try refreshing the page.`);

        // Try to re-establish connection
        initializePeerConnection(peerId);

        // Update UI to show connection issue
        const downloadBtn = document.querySelector(`button[data-file-id="${fileId}"]`);
        if (downloadBtn) {
            downloadBtn.textContent = "Reconnecting...";

            // Try again after 3 seconds if connection established
            setTimeout(() => {
                if (peers[peerId] && peers[peerId].connected) {
                    requestFileFromPeer(peerId, fileId);
                } else {
                    downloadBtn.textContent = "Connection Failed";
                    downloadBtn.disabled = true;
                }
            }, 3000);
        }
        return;
    }

    // Send file request message
    const message = JSON.stringify({
        type: 'file-request',
        fileId: fileId
    });

    try {
        peers[peerId].connection.send(message);

        // Update UI
        const downloadBtn = document.querySelector(`button[data-file-id="${fileId}"]`);
        if (downloadBtn) {
            downloadBtn.textContent = "Downloading...";
            downloadBtn.disabled = true;
        }

        // Update status
        updateFileDownloadStatus(fileId, "Requesting file...");
    } catch (error) {
        console.error(`Error requesting file from peer ${peerId}:`, error);
        showToast(`Error requesting file: ${error.message}`);

        // Update UI
        const downloadBtn = document.querySelector(`button[data-file-id="${fileId}"]`);
        if (downloadBtn) {
            downloadBtn.textContent = "Retry";
            downloadBtn.disabled = false;
        }
    }
}

export async function handleFileData(fileId, fileName, chunk, totalChunks, chunkIndex) {
    //console.log(`Receiving chunk ${chunkIndex + 1}/${totalChunks} for file ${fileName}`);

    // Initialize file record if it doesn't exist
    if (!files[fileId]) {
        files[fileId] = {
            name: fileName,
            chunks: new Array(totalChunks),
            receivedChunks: 0,
            totalChunks: totalChunks,
            size: 0,
            processedChunks: new Set() // Track which chunks we've already processed
        };
    }

    // Skip if we already processed this chunk
    if (files[fileId].processedChunks && files[fileId].processedChunks.has(chunkIndex)) {
        //console.log(`Chunk ${chunkIndex} already processed, skipping`);
        return;
    }

    try {
        // Convert chunk to ArrayBuffer
        let binaryChunk;

        if (chunk instanceof ArrayBuffer) {
            binaryChunk = chunk;
        } else if (typeof chunk === 'string') {
            try {
                binaryChunk = new TextEncoder().encode(chunk).buffer;
            } catch (error) {
                console.error("Error converting string chunk:", error);
                binaryChunk = new ArrayBuffer(0); // Fallback to empty buffer
            }
        } else if (chunk instanceof Blob) {
            binaryChunk = await chunk.arrayBuffer();
        } else if (typeof chunk === 'object') {
            // Handle object type
            console.log("Handling object type chunk");
            try {
                const jsonString = JSON.stringify(chunk);
                binaryChunk = new TextEncoder().encode(jsonString).buffer;
            } catch (e) {
                console.error("Error converting object chunk:", e);
                if (chunk && chunk.data) {
                    if (typeof chunk.data === 'string') {
                        binaryChunk = new TextEncoder().encode(chunk.data).buffer;
                    } else if (chunk.data instanceof ArrayBuffer) {
                        binaryChunk = chunk.data;
                    } else {
                        binaryChunk = new ArrayBuffer(0);
                    }
                } else {
                    binaryChunk = new ArrayBuffer(0);
                }
            }
        } else {
            console.error(`Unsupported chunk type: ${typeof chunk}`);
            binaryChunk = new ArrayBuffer(0);
        }

        // Store the chunk
        files[fileId].chunks[chunkIndex] = binaryChunk;
        files[fileId].processedChunks.add(chunkIndex);
        files[fileId].receivedChunks++;
        files[fileId].size += binaryChunk.byteLength;

        // Update UI with progress
        updateFileDownloadStatus(fileId, `Downloading: ${files[fileId].receivedChunks}/${totalChunks} chunks (${(files[fileId].size / 1024).toFixed(2)} KB)`);

        // Check if file is complete
        if (files[fileId].receivedChunks === totalChunks) {
            console.log(`All ${totalChunks} chunks received for ${fileName}, assembling file...`);

            try {
                // Create Blob from all chunks
                const nonNullChunks = files[fileId].chunks.filter(c => c !== null && c !== undefined);
                const blob = new Blob(nonNullChunks, { type: 'application/octet-stream' });

                // Create download URL
                const url = URL.createObjectURL(blob);

                // Update file info
                files[fileId].completeBlob = blob;
                files[fileId].completeUrl = url;

                // Update UI
                updateFileDownloadStatus(fileId, `Complete: ${(blob.size / 1024).toFixed(2)} KB`);

                // Show success message
                showToast(`File "${fileName}" downloaded successfully!`);
            } catch (error) {
                console.error(`Error creating file blob: ${error.message}`);
                updateFileDownloadStatus(fileId, `Error: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`Error processing chunk ${chunkIndex} for file ${fileName}:`, error);
        updateFileDownloadStatus(fileId, `Error: ${error.message}`);
    }
}

export function sendFileToPeer(peerId, fileId, file) {
    //console.log(`Sending file ${file.name} (ID: ${fileId}) to peer ${peerId}`);

    if (!peers[peerId] || !peers[peerId].connection) {
        console.error(`No connection to peer ${peerId}`);
        return;
    }

    const peer = peers[peerId].connection;
    const chunkSize = 16384;
    const totalChunks = Math.ceil(file.size / chunkSize);

    //console.log(`File will be sent in ${totalChunks} chunks (total: ${file.size} bytes)`);

    // Track sent chunks
    const sentChunks = new Set();
    let completedChunks = 0;

    // Maximum parallel transfers 
    const maxParallel = 5;
    let activeTransfers = 0;

    function sendChunk(index) {
        if (sentChunks.has(index) || index >= totalChunks) return;

        // Mark this chunk as being processed
        sentChunks.add(index);
        activeTransfers++;

        // Calculate chunk boundaries
        const start = index * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const chunk = file.slice(start, end);

        // Read chunk data
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const arrayBuffer = reader.result;
    
                const message = {
                    type: 'file-data',
                    fileId: fileId,
                    fileName: file.name,
                    chunkIndex: index,
                    totalChunks: totalChunks
                };
                const metaBuffer = new TextEncoder().encode(JSON.stringify(message));
                const separator = new Uint8Array([0]);

                //We can extract on receiving side by splitting the buffer
                const fullMessage = new Blob([metaBuffer, separator, arrayBuffer]);

                // Send to peer
                //peer.send(JSON.stringify(message));
                peer.send(fullMessage);

                // Update counters
                completedChunks++;
                activeTransfers--;

                // Log progress periodically
                if (completedChunks % 10 === 0 || completedChunks === totalChunks) {
                    console.log(`Sent ${completedChunks}/${totalChunks} chunks (${Math.round((completedChunks / totalChunks) * 100)}%)`);
                }

                // Check if we're done
                if (completedChunks === totalChunks) {
                    console.log(`Finished sending file ${file.name}`);
                    return;
                }

                // Start next chunk if we have capacity
                if (activeTransfers < maxParallel) {
                    // Find next unsent chunk
                    let nextIndex = 0;
                    while (nextIndex < totalChunks && sentChunks.has(nextIndex)) {
                        nextIndex++;
                    }

                    if (nextIndex < totalChunks) {
                        setTimeout(() => sendChunk(nextIndex), 0);
                    }
                }
            } catch (error) {
                console.error(`Error sending chunk ${index}:`, error);
                // Remove from sent set so we can retry
                sentChunks.delete(index);
                activeTransfers--;

                // Retry after a delay
                setTimeout(() => sendChunk(index), 500);
            }
        };

        reader.onerror = (error) => {
            console.error(`Error reading chunk ${index}:`, error);
            sentChunks.delete(index);
            activeTransfers--;
            setTimeout(() => sendChunk(index), 1000);
        };

        reader.readAsArrayBuffer(chunk);
    }

    // Start initial transfers
    for (let i = 0; i < Math.min(maxParallel, totalChunks); i++) {
        sendChunk(i);
    }
}