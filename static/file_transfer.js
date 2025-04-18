import { broadcastFileList } from "./websocket.js";
import { updateFileDownloadStatus, showToast, addFileToUI, updateSenderFileStatus } from "./ui.js";
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
        files[fileId].downloaders = {};
        addFileToUI(fileId, file.name, URL.createObjectURL(file), file.size, true, {});
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
            ownedByMe: true,
            downloaders: fileObj.downloaders || {}
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
            addFileToUI(fileInfo.fileId, fileInfo.fileName, fileInfo.url, fileInfo.size, true, fileInfo.downloaders);
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

    // Track downloaders for this file
    if (!file.downloaders) {
        file.downloaders = {};
    }
    file.downloaders[peerId] = {
        status: 'starting',
        progress: 0,
        startTime: Date.now()
    };

    // Update UI to show someone is downloading this file
    updateSenderFileStatus(fileId, file.downloaders);

    // Adding a slight delay to ensure connection is stable
    setTimeout(() => {
        sendFileToPeer(peerId, fileId, file);
    }, 100);
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

        // Send progress update to the sender every 10% 
        const progress = Math.round((files[fileId].receivedChunks / totalChunks) * 100);
        // Send updates on 10% intervals
        if (progress % 10 === 0) {
            sendDownloadProgressUpdate(fileId, fileName, progress);
        }

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

                // Send completion notification to sender
                sendDownloadProgressUpdate(fileId, fileName, 100, true);

                // Show success message
                showToast(`File "${fileName}" downloaded successfully!`);
            } catch (error) {
                console.error(`Error creating file blob: ${error.message}`);
                updateFileDownloadStatus(fileId, `Error: ${error.message}`);

                // Send error notification to sender
                sendDownloadProgressUpdate(fileId, fileName, -1, false, error.message);
            }
        }
    } catch (error) {
        console.error(`Error processing chunk ${chunkIndex} for file ${fileName}:`, error);
        updateFileDownloadStatus(fileId, `Error: ${error.message}`);

        // Send error notification to sender
        sendDownloadProgressUpdate(fileId, fileName, -1, false, error.message);
    }
}

//send download progress to the sender
function sendDownloadProgressUpdate(fileId, fileName, progress, completed = false, error = null) {
    // Extract owner peer ID from fileId
    const ownerPeerId = fileId.split('-')[0];

    // Don't send update if we're the owner
    if (ownerPeerId === myPeerId) return;

    // Check if connection to owner exists
    if (!peers[ownerPeerId] || !peers[ownerPeerId].connection) {
        console.log(`No connection to file owner ${ownerPeerId}, can't send progress update`);
        return;
    }

    try {
        const message = JSON.stringify({
            type: 'download-progress',
            fileId: fileId,
            fileName: fileName,
            progress: progress,
            downloaderId: myPeerId,
            completed: completed,
            error: error
        });

        peers[ownerPeerId].connection.send(message);
    } catch (err) {
        console.error(`Error sending progress update to file owner: ${err.message}`);
    }
}

export function handleDownloadProgress(fileId, progress, downloaderId, completed, error) {

    // Check if this is our file
    const file = files[fileId];
    if (!file) {
        console.log(`File ${fileId} not found in our files, ignoring progress update`);
        return;
    }

    // Initialize downloaders tracking if needed
    if (!file.downloaders) {
        file.downloaders = {};
    }

    // Update or initialize downloader status
    if (!file.downloaders[downloaderId]) {
        file.downloaders[downloaderId] = {
            status: 'downloading',
            progress: progress,
            startTime: Date.now()
        };
    } else {
        file.downloaders[downloaderId].progress = progress;

        if (completed) {
            file.downloaders[downloaderId].status = 'completed';
            file.downloaders[downloaderId].completedTime = Date.now();
        } else if (error) {
            file.downloaders[downloaderId].status = 'error';
            file.downloaders[downloaderId].error = error;
        } else {
            file.downloaders[downloaderId].status = 'downloading';
        }
    }

    // Update UI to show download progress
    updateSenderFileStatus(fileId, file.downloaders);
}

export function sendFileToPeer(peerId, fileId, file) {
    if (!peers[peerId] || !peers[peerId].connection) {
        console.error(`No connection to peer ${peerId}`);
        return;
    }

    const peer = peers[peerId].connection;
    const chunkSize = 16384; // 16KB chunks
    const totalChunks = Math.ceil(file.size / chunkSize);

    // Track sent chunks and queue
    const sentChunks = new Set();
    let completedChunks = 0;
    const chunkQueue = [];
    let sending = false;

    const maxParallel = 4;
    let activeTransfers = 0;

    // Update downloader status
    if (!file.downloaders) file.downloaders = {};
    file.downloaders[peerId] = {
        status: 'downloading',
        progress: 0,
        startTime: Date.now()
    };
    updateSenderFileStatus(fileId, file.downloaders);

    // Function to process the next chunk in queue
    function processQueue() {
        if (sending || chunkQueue.length === 0) return;

        sending = true;
        const index = chunkQueue.shift();

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
                const fullMessage = new Blob([metaBuffer, separator, arrayBuffer]);

                // Send to peer with backpressure handling
                try {
                    peer.send(fullMessage);

                    // Update counters
                    completedChunks++;
                    activeTransfers--;

                    // Log progress periodically
                    const progressPercentage = Math.round((completedChunks / totalChunks) * 100);
                    if (progressPercentage % 10 === 0 || completedChunks === totalChunks) {
                        console.log(`Sent ${progressPercentage}% of ${file.name}`);

                        // Update downloader progress in our tracking
                        if (file.downloaders && file.downloaders[peerId]) {
                            file.downloaders[peerId].progress = progressPercentage;
                            updateSenderFileStatus(fileId, file.downloaders);
                        }
                    }

                    // Check if we're done
                    if (completedChunks === totalChunks) {
                        console.log(`Finished sending file ${file.name}`);

                        // Update downloader status to completed
                        if (file.downloaders && file.downloaders[peerId]) {
                            file.downloaders[peerId].status = 'completed';
                            file.downloaders[peerId].completedTime = Date.now();
                            updateSenderFileStatus(fileId, file.downloaders);
                        }
                        return;
                    }

                    // to prevent overwhelming the channel
                    setTimeout(() => {
                        sending = false;
                        processQueue();
                    }, 0);

                    // Queue more chunks if needed
                    queueNextChunks();
                } catch (error) {
                    //console.error(`Error sending chunk ${index}:`, error);

                    if (error.message && error.message.includes('send queue is full')) {
                        // Put the chunk back in the queue for retry
                        chunkQueue.unshift(index);
                        activeTransfers--;

                        // Wait longer before retrying
                        setTimeout(() => {
                            sending = false;
                            processQueue();
                        }, 200);
                    } else {
                        // For other errors, wait a bit and retry
                        sentChunks.delete(index);
                        activeTransfers--;
                        setTimeout(() => {
                            sending = false;
                            chunkQueue.unshift(index);
                            processQueue();
                        }, 1000);
                    }
                }
            } catch (error) {
                //console.error(`Error processing chunk ${index}:`, error);
                sentChunks.delete(index);
                activeTransfers--;
                setTimeout(() => {
                    sending = false;
                    chunkQueue.unshift(index);
                    processQueue();
                }, 1000);
            }
        };

        reader.onerror = (error) => {
            //console.error(`Error reading chunk ${index}:`, error);
            sentChunks.delete(index);
            activeTransfers--;
            setTimeout(() => {
                sending = false;
                chunkQueue.unshift(index);
                processQueue();
            }, 1000);
        };

        reader.readAsArrayBuffer(chunk);
    }

    // Function to queue chunks for sending
    function queueNextChunks() {
        // Only queue chunks if we're under the parallel limit and there are chunks left
        while (activeTransfers < maxParallel && chunkQueue.length < maxParallel * 4) {
            // Find next unsent chunk
            let nextIndex = 0;
            while (nextIndex < totalChunks && (sentChunks.has(nextIndex) || chunkQueue.includes(nextIndex))) {
                nextIndex++;
            }

            if (nextIndex < totalChunks) {
                sentChunks.add(nextIndex);
                chunkQueue.push(nextIndex);
                activeTransfers++;
            } else {
                break; // No more chunks to queue
            }
        }

        // Start processing if not already processing
        if (!sending && chunkQueue.length > 0) {
            processQueue();
        }
    }

    // Start the transfer process
    queueNextChunks();
}