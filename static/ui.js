import { requestFileFromPeer } from "./file_transfer.js";
import { getPeerIdFromFileId } from "./utility.js";

export function addFileToUI(fileId, fileName, url, fileSize, ownedByMe = true) {
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
            statusElement.id = `status-${fileId}`; // Ensure it has the correct ID
            statusElement.textContent = 'Ready to download';
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
                    </div>
                    <a href="${url}" download="${fileName}" class="download-btn">Download</a>
                `;
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