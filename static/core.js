import { handleFiles } from './file_transfer.js';
import { showToast } from './ui.js';
import { initWebSocket } from './websocket.js';


export async function init() {
    console.log("Initializing...");

    try {

        // Set up file drop zone
        const fileDrop = document.getElementById('fileDrop');
        const fileInput = document.getElementById('fileInput');

        fileDrop.addEventListener('click', () => {
            fileInput.click();
        });

        fileDrop.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileDrop.classList.add('active');
        });

        fileDrop.addEventListener('dragleave', () => {
            fileDrop.classList.remove('active');
        });

        fileDrop.addEventListener('drop', (e) => {
            e.preventDefault();
            fileDrop.classList.remove('active');

            if (e.dataTransfer.files.length > 0) {
                handleFiles(e.dataTransfer.files);
            }
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                handleFiles(fileInput.files);
            }
        });

        // Setup copy button
        document.getElementById('copyCodeBtn').addEventListener('click', () => {
            const roomCode = document.getElementById('roomCode').textContent;
            console.log("Copying room code:", roomCode);

            try {
                navigator.clipboard.writeText(roomCode)
                    .then(() => {
                        console.log("Room code copied to clipboard");
                        const copyBtn = document.getElementById('copyCodeBtn');
                        copyBtn.textContent = 'Copied!';
                        showToast('Room code copied to clipboard!');
                        setTimeout(() => {
                            copyBtn.textContent = 'Copy';
                        }, 2000);
                    })
                    .catch(err => {
                        console.error("Failed to copy:", err);
                        showToast('Failed to copy room code');
                    });
            } catch (error) {
                console.error("Error copying room code:", error);
                // Fallback for browsers that don't support clipboard API
                const tempInput = document.createElement('input');
                tempInput.value = roomCode;
                document.body.appendChild(tempInput);
                tempInput.select();
                // Deprecated method, but still works in some cases
                document.execCommand('copy');
                document.body.removeChild(tempInput);
                const copyBtn = document.getElementById('copyCodeBtn');
                copyBtn.textContent = 'Copied!';
                showToast('Room code copied to clipboard!');
                setTimeout(() => {
                    copyBtn.textContent = 'Copy';
                }, 2000);
            }
        });

    } catch (error) {
        console.error("Initialization error:", error);
        updateStatus(`Error: ${error.message}`);
    }
    document.getElementById('shareLink').value = window.location.href;
    document.getElementById('shareLinkBtn').addEventListener('click', () => {
        const shareLink = document.getElementById('shareLink');
        shareLink.select();
        navigator.clipboard.writeText(shareLink.value)
            .then(() => showToast('Link copied to clipboard!'));
    });
    initWebSocket();
}

export function updateStatus(message) {
    const statusElement = document.getElementById('status');
    statusElement.textContent = message;
}
