// Helper function to convert ArrayBuffer to base64
export function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

export function getPeerIdFromFileId(fileId) {
    // File IDs are formatted as "peerId-timestamp-filename"
    return fileId.split('-')[0];
}
