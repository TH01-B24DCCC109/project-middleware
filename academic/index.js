const express = require('express');
const crypto = require('crypto');
const amqp = require('amqplib');
const { writeLog } = require('../shared/logger');

const PORT = Number(process.env.PORT || 3001);
const FINANCE_URL = (process.env.FINANCE_URL || 'http://localhost:3002').replace(/\/+$/, '');
const AMQP_URL = process.env.AMQP_URL || 'amqp://localhost:5672';
const TUITION_QUEUE = process.env.TUITION_QUEUE || 'tuition.create';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 3000);
const RETRY_COUNT = Number(process.env.RETRY_COUNT || 2);

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function validateTuitionRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'Dữ liệu yêu cầu phải là một đối tượng JSON';
    }
    if (typeof body.studentId !== 'string' || !body.studentId.trim()
        || typeof body.term !== 'string' || !body.term.trim()
        || body.amount === undefined || body.amount === null
        || (typeof body.amount !== 'number' && typeof body.amount !== 'string')
        || (typeof body.amount === 'string' && !body.amount.trim())) {
        return 'Thiếu studentId, term hoặc amount';
    }
    if (!Number.isFinite(Number(body.amount)) || Number(body.amount) <= 0) {
        return 'amount phải là số dương';
    }
    return null;
}

async function callFinance(payload) {
    if (Date.now() < circuitOpenUntil) {
        const retryAfterSeconds = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
        const error = new Error('Cụm Finance đang tạm ngừng (circuit breaker mở)');
        error.code = 'CIRCUIT_OPEN';
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
    }

    let lastError;
    for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(`${FINANCE_URL}/api/tuition/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            let responseBody;
            try {
                responseBody = await response.json();
            } catch {
                const error = new Error('Finance trả về dữ liệu JSON không hợp lệ');
                error.statusCode = 502;
                error.retriable = true;
                throw error;
            }

            if (!response.ok) {
                const error = new Error(responseBody.message || `Finance trả HTTP ${response.status}`);
                error.statusCode = response.status;
                error.responseBody = responseBody;
                error.retriable = response.status === 408 || response.status === 429 || response.status >= 500;
                throw error;
            }

            if (!responseBody || typeof responseBody !== 'object'
                || !['CREATED', 'DUPLICATE'].includes(responseBody.status)) {
                const error = new Error('Finance trả về phản hồi không đúng định dạng');
                error.statusCode = 502;
                error.retriable = true;
                throw error;
            }

            consecutiveFailures = 0;
            return responseBody;
        } catch (error) {
            lastError = error;
            if (error.statusCode && !error.retriable) {
                consecutiveFailures = 0;
                throw error;
            }
            if (attempt < RETRY_COUNT) {
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
            }
        } finally {
            clearTimeout(timer);
        }
    }

    consecutiveFailures++;
    if (consecutiveFailures >= 3) {
        circuitOpenUntil = Date.now() + 30000;
    }

    throw lastError;
}

function createRabbitMqPublisher({
    url = AMQP_URL,
    queue = TUITION_QUEUE,
    connect = amqp.connect
} = {}) {
    let connection = null;
    let channel = null;
    let channelPromise = null;

    async function getChannel() {
        if (channel) return channel;
        if (!channelPromise) {
            channelPromise = (async () => {
                const nextConnection = await connect(url);
                connection = nextConnection;
                nextConnection.on('error', error => {
                    console.error(`RabbitMQ connection error: ${error.message}`);
                });
                nextConnection.once('close', () => {
                    if (connection === nextConnection) {
                        connection = null;
                        channel = null;
                        channelPromise = null;
                    }
                });

                try {
                    const nextChannel = await nextConnection.createConfirmChannel();
                    channel = nextChannel;
                    nextChannel.on('error', error => {
                        console.error(`RabbitMQ channel error: ${error.message}`);
                    });
                    nextChannel.once('close', () => {
                        if (channel === nextChannel) {
                            channel = null;
                            channelPromise = null;
                        }
                    });
                    await nextChannel.assertQueue(queue, { durable: true });
                    return nextChannel;
                } catch (error) {
                    if (connection === nextConnection) {
                        connection = null;
                        channel = null;
                        channelPromise = null;
                    }
                    await nextConnection.close().catch(closeError => {
                        console.error(`RabbitMQ connection close error: ${closeError.message}`);
                    });
                    throw error;
                }
            })().catch(error => {
                channelPromise = null;
                throw error;
            });
        }
        return channelPromise;
    }

    return async function publishTuition(payload) {
        const activeChannel = await getChannel();
        await new Promise((resolve, reject) => {
            activeChannel.sendToQueue(
                queue,
                Buffer.from(JSON.stringify(payload)),
                {
                    persistent: true,
                    contentType: 'application/json',
                    messageId: payload.requestId,
                    timestamp: Date.now(),
                    type: 'tuition.create'
                },
                error => error ? reject(error) : resolve()
            );
        });
        return { queue, messageId: payload.requestId };
    };
}

const publishTuitionToRabbitMq = createRabbitMqPublisher();

function createAcademicApp({
    financeRequest = callFinance,
    publishTuition = publishTuitionToRabbitMq,
    log = writeLog
} = {}) {
    const app = express();
    app.use(express.json());

    app.post('/api/academic/tuition/sync', async (req, res) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? req.body
            : {};
        const suppliedRequestId = req.headers['x-request-id'] || body.requestId;
        const requestId = typeof suppliedRequestId === 'string' && suppliedRequestId.trim()
            ? suppliedRequestId.trim()
            : crypto.randomUUID();
        const payload = {
            requestId,
            studentId: typeof body.studentId === 'string' ? body.studentId.trim() : body.studentId,
            term: typeof body.term === 'string' ? body.term.trim() : body.term,
            amount: body.amount,
            description: typeof body.description === 'string' && body.description.trim()
                ? body.description.trim()
                : `Học phí kỳ ${body.term || ''}`.trim()
        };

        const validationError = validateTuitionRequest(payload);
        if (validationError) {
            log('Academic', 'SYNC', requestId, 'REJECTED', 'VALIDATION_ERROR', validationError);
            return res.status(400).json({ success: false, requestId, message: validationError });
        }
        payload.amount = Number(payload.amount);

        log('Academic', 'SYNC', requestId, 'SENT', 'SENT_TO_FINANCE', 'Bắt đầu gọi REST đồng bộ');

        try {
            const result = await financeRequest(payload);
            log('Academic', 'SYNC', requestId, 'PROCESSED', 'SUCCESS', `Finance kết quả: ${result.status}`);
            return res.status(result.status === 'CREATED' ? 201 : 200).json({
                success: true,
                requestId,
                mode: 'SYNC',
                finance: result
            });
        } catch (error) {
            const status = error.code === 'CIRCUIT_OPEN' ? 503 : (error.statusCode || 503);
            log('Academic', 'SYNC', requestId, 'PROCESSED', 'FAILED', error.message);
            return res.status(status).json({
                success: false,
                requestId,
                mode: 'SYNC',
                message: error.code === 'CIRCUIT_OPEN' || error.statusCode
                    ? error.message
                    : 'Không thể tạo học phí do lỗi kết nối hoặc xử lý tại Finance',
                retryAfterSeconds: error.retryAfterSeconds
            });
        }
    });

    app.post('/api/academic/tuition/async', async (req, res) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? req.body
            : {};
        const suppliedRequestId = req.headers['x-request-id'] || body.requestId;
        const requestId = typeof suppliedRequestId === 'string' && suppliedRequestId.trim()
            ? suppliedRequestId.trim()
            : crypto.randomUUID();
        const payload = {
            requestId,
            studentId: typeof body.studentId === 'string' ? body.studentId.trim() : body.studentId,
            term: typeof body.term === 'string' ? body.term.trim() : body.term,
            amount: body.amount,
            description: typeof body.description === 'string' && body.description.trim()
                ? body.description.trim()
                : `Học phí kỳ ${body.term || ''}`.trim()
        };

        const validationError = validateTuitionRequest(payload);
        if (validationError) {
            log('Academic', 'ASYNC', requestId, 'REJECTED', 'VALIDATION_ERROR', validationError);
            return res.status(400).json({ success: false, requestId, message: validationError });
        }
        payload.amount = Number(payload.amount);

        try {
            const published = await publishTuition(payload);
            log('Academic', 'ASYNC', requestId, 'SENT', 'PUBLISHED', `Đã xác nhận gửi vào queue ${published.queue}`);
            return res.status(202).json({
                success: true,
                requestId,
                mode: 'ASYNC',
                status: 'PUBLISHED',
                queue: published.queue
            });
        } catch (error) {
            log('Academic', 'ASYNC', requestId, 'PROCESSED', 'PUBLISH_FAILED', error.message);
            return res.status(503).json({
                success: false,
                requestId,
                mode: 'ASYNC',
                status: 'PUBLISH_FAILED',
                message: 'Không thể gửi yêu cầu vào RabbitMQ'
            });
        }
    });

    app.get('/api/academic/health', (_req, res) => {
        res.json({
            service: 'Academic',
            modes: ['SYNC', 'ASYNC'],
            financeUrl: FINANCE_URL,
            rabbitMqUrl: AMQP_URL,
            tuitionQueue: TUITION_QUEUE,
            circuitBreakerOpen: Date.now() < circuitOpenUntil
        });
    });

    return app;
}

const app = createAcademicApp();

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Academic đồng bộ đang chạy tại http://localhost:${PORT}`);
    });
}

module.exports = {
    app,
    callFinance,
    createAcademicApp,
    createRabbitMqPublisher,
    validateTuitionRequest
};
