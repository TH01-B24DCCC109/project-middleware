const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'system_logs.json');

function writeLog(service, mode, requestId, action, status, note = '') {
    const now = new Date().toISOString();

    console.log(`[${now}] [${service}] [${mode}] [${requestId}] ${action} -> ${status} ${note ? `(${note})` : ''}`);

    // Đọc dữ liệu log cũ từ file JSON
    let logs = [];
    if (fs.existsSync(logFile)) {
        try {
            logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        } catch (e) {
            logs = [];
        }
    }

    let record = logs.find(item => item.requestId === requestId && item.mode === mode);
    if (!record) {
        record = {
            requestId: requestId,
            mode: mode,
            sentAt: null,       // 1. Thời điểm gửi
            receivedAt: null,   // 2. Thời điểm tiếp nhận
            processedAt: null,  // 3. Thời điểm xử lý
            status: status,     // 4. Trạng thái thông điệp
            notes: []
        };
        logs.push(record);
    }

    if (action === 'SENT') {
        record.sentAt = now;
    } else if (action === 'RECEIVED') {
        record.receivedAt = now;
    } else if (action === 'PROCESSED' || action === 'DUPLICATE_IGNORED') {
        record.processedAt = now;
    }

    record.status = status;
    if (note) {
        record.notes.push(`[${service}] ${note}`);
    }

    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

module.exports = { writeLog };