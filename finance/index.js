const express = require('express');
const fs = require('fs');
const path = require('path');
const { writeLog } = require('../shared/logger');

const PORT = Number(process.env.PORT || 3002);
const defaultDataFile = path.join(__dirname, 'tuition_records.json');

function readRecords(file = defaultDataFile) {
    if (!fs.existsSync(file)) return [];
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(records)) {
        throw new Error('Dữ liệu khoản học phí phải có định dạng mảng JSON');
    }
    return records;
}

function writeRecords(records, file = defaultDataFile) {
    fs.writeFileSync(file, JSON.stringify(records, null, 2));
}

function createFinanceApp({ dataFile = defaultDataFile, log = writeLog } = {}) {
    const app = express();
    app.use(express.json());

    app.post('/api/tuition/create', (req, res) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? req.body
            : {};
        const { requestId, studentId, term, amount, description } = body;

        if (typeof requestId !== 'string' || !requestId.trim()
            || typeof studentId !== 'string' || !studentId.trim()
            || typeof term !== 'string' || !term.trim()
            || (typeof amount !== 'number' && typeof amount !== 'string')
            || (typeof amount === 'string' && !amount.trim())
            || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
            if (typeof requestId === 'string' && requestId.trim()) {
                log('Finance', 'SYNC', requestId.trim(), 'RECEIVED', 'VALIDATION_ERROR', 'Dữ liệu REST không hợp lệ');
                log('Finance', 'SYNC', requestId.trim(), 'PROCESSED', 'VALIDATION_ERROR', 'Yêu cầu bị từ chối');
            }
            return res.status(400).json({ success: false, message: 'Thiếu requestId, studentId, term hoặc amount không hợp lệ' });
        }

        const normalizedRequestId = requestId.trim();
        const normalizedStudentId = studentId.trim();
        const normalizedTerm = term.trim();
        log('Finance', 'SYNC', normalizedRequestId, 'RECEIVED', 'RECEIVED_AT_FINANCE', 'Finance đã tiếp nhận REST request');

        let records;
        try {
            records = readRecords(dataFile);
        } catch (error) {
            log('Finance', 'SYNC', normalizedRequestId, 'PROCESSED', 'FAILED', `Không đọc được dữ liệu học phí: ${error.message}`);
            return res.status(500).json({ success: false, requestId: normalizedRequestId, message: 'Không thể đọc dữ liệu học phí tại Finance' });
        }

        const existing = records.find(record => record.requestId === normalizedRequestId);
        if (existing) {
            log('Finance', 'SYNC', normalizedRequestId, 'PROCESSED', 'DUPLICATE_IGNORED', 'Đã bỏ qua request trùng mã định danh');
            return res.status(200).json({
                success: true,
                status: 'DUPLICATE',
                requestId: normalizedRequestId,
                tuitionId: existing.tuitionId,
                message: 'Yêu cầu đã được tạo trước đó'
            });
        }

        const tuitionId = `FEE-${Date.now()}-${normalizedRequestId.slice(0, 8)}`;
        const record = {
            tuitionId,
            requestId: normalizedRequestId,
            studentId: normalizedStudentId,
            term: normalizedTerm,
            amount: Number(amount),
            description: typeof description === 'string' && description.trim()
                ? description.trim()
                : `Học phí kỳ ${normalizedTerm}`,
            mode: 'SYNC',
            createdAt: new Date().toISOString()
        };
        records.push(record);
        try {
            writeRecords(records, dataFile);
        } catch (error) {
            log('Finance', 'SYNC', normalizedRequestId, 'PROCESSED', 'FAILED', `Không lưu được khoản học phí: ${error.message}`);
            return res.status(500).json({ success: false, requestId: normalizedRequestId, message: 'Không thể lưu khoản học phí tại Finance' });
        }

        log('Finance', 'SYNC', normalizedRequestId, 'PROCESSED', 'SUCCESS', `Đã tạo khoản học phí ${tuitionId}`);

        return res.status(201).json({
            success: true,
            status: 'CREATED',
            requestId: normalizedRequestId,
            tuitionId,
            studentId: normalizedStudentId,
            term: normalizedTerm,
            amount: Number(amount)
        });
    });

    app.get('/api/tuition/records', (_req, res) => {
        const records = readRecords(dataFile);
        res.json({ count: records.length, records });
    });

    app.get('/api/finance/health', (_req, res) => {
        res.json({ service: 'Finance', mode: 'SYNC', status: 'UP' });
    });

    return app;
}

const app = createFinanceApp();

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Finance đồng bộ đang chạy tại http://localhost:${PORT}`);
    });
}

module.exports = { app, createFinanceApp, readRecords, writeRecords };
