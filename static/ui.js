import { requestFileFromPeer } from "./file_transfer.js";
import { getPeerIdFromFileId } from "./utility.js";

export function addFileToUI(fileId, fileName, url, fileSize, ownedByMe = true, downloaders = {}) {
    const fileList = document.getElementById('fileList');
    const existingItem = document.querySelector(`#fileList li[data-file-id="${fileId}"]`);
    if (existingItem) {
        const downloadBtn = existingItem.querySelector('.download-btn');
        if (downloadBtn && url) {
            // Convert button to download link if we have a URL
            const downloadLink = document.createElement('a');
            downloadLink.href = url;
            downloadLink.download = fileName;
            downloadLink.className = 'download-btn';
            downloadLink.textContent = 'Download';
            downloadBtn.parentNode.replaceChild(downloadLink, downloadBtn);
        }

        // Update the status if it exists
        const statusElement = existingItem.querySelector('.file-status');
        if (statusElement) {
            statusElement.id = `status-${fileId}`; 
            statusElement.textContent = 'Ready to download';
        }
        if (ownedByMe && Object.keys(downloaders).length > 0) {
            updateSenderFileStatus(fileId, downloaders);
        }

        return;
    }

    // Format file size consistently
    const displaySize = fileSize ?
        (parseInt(fileSize) / 1024).toFixed(2) + ' KB' :
        (files[fileId] && files[fileId].size ?
            (parseInt(files[fileId].size) / 1024).toFixed(2) + ' KB' : 'Unknown size');

    const listItem = document.createElement('li');
    listItem.className = 'file-item';
    listItem.setAttribute('data-file-id', fileId);

    if (ownedByMe) {
        // For files I own
        listItem.innerHTML = `
                    <div class="file-info">
                        <span class="file-name">${fileName}</span>
                        <span class="file-meta">Size: ${displaySize}</span>
                        <span class="file-status">Your file</span>
                        <div class="downloaders-status" id="downloaders-${fileId}"></div>
                    </div>
                    <a href="${url}" download="${fileName}" class="download-btn">Download</a>
                `;
        if (Object.keys(downloaders).length > 0) {
            updateSenderFileStatus(fileId, downloaders);
        }
    } else {
        // For files from peers
        listItem.innerHTML = `
                    <div class="file-info">
                        <span class="file-name">${fileName}</span>
                        <span class="file-meta">Size: ${displaySize}</span>
                        <span class="file-status" id="status-${fileId}">Available from peer</span>
                    </div>
                    <button class="download-btn" data-file-id="${fileId}" data-peer-id="${getPeerIdFromFileId(fileId)}">Download</button>
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
    }

    fileList.appendChild(listItem);

    // Remove placeholder if present
    const placeholder = document.querySelector('#fileList li:first-child');
    if (placeholder && placeholder.textContent.includes('No files shared yet')) {
        placeholder.remove();
    }
}

export function updateSenderFileStatus(fileId, downloaders) {
    let downloadersContainer = document.getElementById(`downloaders-${fileId}`);
    
    // If not found, add it
    if (!downloadersContainer) {
        const fileItem = document.querySelector(`li[data-file-id="${fileId}"]`);
        if (!fileItem) return;
        
        // Find or create the file-info section
        let fileInfo = fileItem.querySelector('.file-info');
        if (!fileInfo) {
            fileInfo = document.createElement('div');
            fileInfo.className = 'file-info';
            fileItem.appendChild(fileInfo);
        }
        
        // Create downloaders container
        downloadersContainer = document.createElement('div');
        downloadersContainer.className = 'downloaders-status';
        downloadersContainer.id = `downloaders-${fileId}`;
        fileInfo.appendChild(downloadersContainer);
    }
    
    // Clear and rebuild the list
    downloadersContainer.innerHTML = '';
    
    // Get active downloaders
    const activeDownloaders = Object.keys(downloaders).filter(id => 
        downloaders[id].status === 'downloading' || 
        downloaders[id].status === 'starting' ||
        (downloaders[id].status === 'completed' && 
         Date.now() - downloaders[id].completedTime < 10000) // Show completed for 10 seconds
    );
    
    if (activeDownloaders.length === 0) {
        downloadersContainer.style.display = 'none';
        return;
    }
    
    downloadersContainer.style.display = 'block';
    
    // Create header if there are downloaders
    if (activeDownloaders.length > 0) {
        const header = document.createElement('div');
        header.className = 'downloaders-header';
        header.textContent = 'Current Downloads:';
        downloadersContainer.appendChild(header);
    }
    
    // Add each downloader
    activeDownloaders.forEach(peerId => {
        const downloader = downloaders[peerId];
        const downloaderEl = document.createElement('div');
        downloaderEl.className = 'downloader-item';
        
        // Create status text based on state
        let statusText = '';
        let statusClass = '';
        
        switch (downloader.status) {
            case 'starting':
                statusText = `Peer ${peerId}: Preparing transfer...`;
                statusClass = 'status-pending';
                break;
            case 'downloading':
                statusText = `Peer ${peerId}: ${downloader.progress || 0}% Complete`;
                statusClass = 'status-downloading';
                break;
            case 'completed':
                statusText = `Peer ${peerId}: Download Complete`;
                statusClass = 'status-completed';
                break;
            case 'error':
                statusText = `Peer ${peerId}: Error - ${downloader.error || 'Unknown error'}`;
                statusClass = 'status-error';
                break;
            default:
                statusText = `Peer ${peerId}: ${downloader.status}`;
        }
        
        downloaderEl.innerHTML = `
            <span class="downloader-status ${statusClass}">${statusText}</span>
        `;
        
        // Add progress bar for downloading status
        if (downloader.status === 'downloading' && typeof downloader.progress === 'number') {
            const progressBar = document.createElement('div');
            progressBar.className = 'downloader-progress';
            progressBar.innerHTML = `
                <div class="downloader-progress-bar" style="width: ${downloader.progress}%;"></div>
            `;
            downloaderEl.appendChild(progressBar);
        }
        
        downloadersContainer.appendChild(downloaderEl);
    });
}


export function updateFileDownloadStatus(fileId, statusText) {

    const fileItem = document.querySelector(`li[data-file-id="${fileId}"]`);
    if (!fileItem) {
        console.error(`File item for ${fileId} not found`);
        return;
    }

    let statusElement = fileItem.querySelector(`#status-${fileId}`) || fileItem.querySelector('.file-status');
    if (!statusElement) {
        const fileInfo = fileItem.querySelector('.file-info');
        if (!fileInfo) {
            console.error(`Could not find .file-info for ${fileId}`);
            return;
        }
        statusElement = document.createElement('span');
        statusElement.className = 'file-status';
        statusElement.id = `status-${fileId}`;
        fileInfo.appendChild(statusElement);
    } else if (!statusElement.id) {
        statusElement.id = `status-${fileId}`;
    }

    // Update the status text
    statusElement.textContent = statusText;


    if (statusText.includes('Downloading:')) {
        // Extract progress percentage
        const receivedChunks = files[fileId].receivedChunks;
        const totalChunks = files[fileId].totalChunks;
        const percentage = Math.round((receivedChunks / totalChunks) * 100);

        // Add or update progress bar
        let progressBar = fileItem.querySelector(`.progress-bar`);
        if (!progressBar) {
            const fileInfo = fileItem.querySelector('.file-info');
            progressBar = document.createElement('div');
            progressBar.className = 'progress-bar';
            progressBar.innerHTML = `
                <div class="progress-fill-bg"></div>
                <div class="progress-fill"></div>
                <div class="progress-text">0%</div>
            `;



            fileInfo.appendChild(progressBar);
        }

        const progressFillBg = progressBar.querySelector('.progress-fill-bg');
        const progressFill = progressBar.querySelector('.progress-fill');
        const progressText = progressBar.querySelector('.progress-text');

        if (progressFillBg) {
            progressFillBg.style.width = `${percentage}%`;
        }
        if (progressFill) {
            progressFill.style.left = `calc(${percentage}% - 20px)`; 
        }
        if (progressText) {
            progressText.textContent = `${percentage}%`;
        }



        // Update status text to include percentage
        statusElement.textContent = `${statusText} (${percentage}%)`;
    }

    // Update button state if download is complete
    if (statusText.startsWith('Complete:')) {
        const downloadBtn = fileItem.querySelector(`.download-btn`);
        if (downloadBtn) {
            downloadBtn.textContent = 'Save';
            downloadBtn.disabled = false;

            // If we have a URL, replace button with link
            if (files[fileId] && files[fileId].chunks) {
                try {
                    const fileBlob = new Blob(files[fileId].chunks, { type: 'application/octet-stream' });
                    const fileUrl = URL.createObjectURL(fileBlob);

                    const downloadLink = document.createElement('a');
                    downloadLink.href = fileUrl;
                    downloadLink.download = files[fileId].name;
                    downloadLink.className = 'download-btn';
                    downloadLink.textContent = 'Save';

                    downloadLink.addEventListener('click', function () {
                        this.textContent = 'Saved';
                        setTimeout(() => {
                            this.textContent = 'Save';
                        }, 3000);
                    });

                    // Replace the button with the link
                    downloadBtn.parentNode.replaceChild(downloadLink, downloadBtn);
                } catch (error) {
                    console.error(`Error creating download link: ${error.message}`);
                    // Don't attempt to replace if there's an error
                    downloadBtn.textContent = 'Download Ready';
                }
            }
        }
    }
}

export function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show-toast');

    setTimeout(() => {
        toast.classList.remove('show-toast');
    }, duration);
}

export function updatePeersList(peersList = Object.keys(peers)) {
    const peersListElement = document.getElementById('peersList');
    peersListElement.innerHTML = '';
    if (peersList.length === 0) {
        peersListElement.innerHTML = '<li class="peer-item">No peers connected</li>';
        return;
    }
    peersList.forEach(peerId => {
        const listItem = document.createElement('li');
        listItem.className = 'peer-item';
        listItem.innerHTML = `
                    <div class="peer-status"></div>
                    <div>${peerId === myPeerId ? 'You' : `Peer ${peerId}`}</div>
                `;
        peersListElement.appendChild(listItem);
    });
}


export function initDebugConsole() {
    // Create debug console container
    const debugConsole = document.createElement('div');
    debugConsole.id = 'debugConsole';
    debugConsole.style.cssText = 'position: fixed; bottom: 0; left: 0; width: 100%; height: 200px; background: rgba(0,0,0,0.8); color: white; font-family: monospace; overflow-y: auto; z-index: 1000; padding: 10px; display: none;';
    document.body.appendChild(debugConsole);
    
    // Create toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = 'Debug Console';
    toggleBtn.style.cssText = 'position: fixed; bottom: 10px; right: 10px; z-index: 1001; padding: 5px 10px;';
    document.body.appendChild(toggleBtn);
    
    // Toggle console visibility
    toggleBtn.addEventListener('click', () => {
        debugConsole.style.display = debugConsole.style.display === 'none' ? 'block' : 'none';
    });
    
    // Override console methods
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    
    function addToDebugConsole(type, ...args) {
        const line = document.createElement('div');
        line.className = `debug-${type}`;
        line.style.borderBottom = '1px solid #333';
        line.style.padding = '2px 0';
        line.style.color = type === 'error' ? '#ff5555' : type === 'warn' ? '#ffaa00' : '#ffffff';
        
        let message = '';
        args.forEach(arg => {
            if (typeof arg === 'object') {
                try {
                    message += JSON.stringify(arg) + ' ';
                } catch (e) {
                    message += '[Object] ';
                }
            } else {
                message += arg + ' ';
            }
        });
        
        line.textContent = `${type.toUpperCase()}: ${message}`;
        debugConsole.appendChild(line);
        debugConsole.scrollTop = debugConsole.scrollHeight;
    }
    
    console.log = function(...args) {
        originalLog.apply(console, args);
        addToDebugConsole('log', ...args);
    };
    
    console.error = function(...args) {
        originalError.apply(console, args);
        addToDebugConsole('error', ...args);
    };
    
    console.warn = function(...args) {
        originalWarn.apply(console, args);
        addToDebugConsole('warn', ...args);
    };
}