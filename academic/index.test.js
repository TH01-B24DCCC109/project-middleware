const test = require('node:test');
const assert = require('node:assert/strict');
const { callFinance, createAcademicApp, validateTuitionRequest } = require('./index');

async function startServer(t, app) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    t.after(() => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('validates required fields and a positive amount', () => {
    assert.equal(validateTuitionRequest({
        studentId: 'SV001',
        term: 'HK1-2026',
        amount: 5000000
    }), null);
    assert.match(validateTuitionRequest({ studentId: ' ', term: 'HK1-2026', amount: 1 }), /Thiếu/);
    assert.match(validateTuitionRequest({ studentId: 'SV001', term: 'HK1-2026', amount: '' }), /Thiếu/);
    assert.match(validateTuitionRequest({ studentId: 'SV001', term: 'HK1-2026', amount: 0 }), /số dương/);
    assert.match(validateTuitionRequest(null), /đối tượng JSON/);
});

test('retries a transient Finance error and returns the successful response', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (calls === 1) {
            return new Response(JSON.stringify({ message: 'Tạm thời lỗi' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(JSON.stringify({ status: 'CREATED', tuitionId: 'FEE-1' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
        });
    });

    const result = await callFinance({ requestId: 'request-1' });

    assert.equal(calls, 2);
    assert.equal(result.status, 'CREATED');
});

test('does not retry a non-retriable Finance response', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(JSON.stringify({ message: 'Dữ liệu không hợp lệ' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    });

    await assert.rejects(callFinance({ requestId: 'request-2' }), error => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.message, 'Dữ liệu không hợp lệ');
        return true;
    });
    assert.equal(calls, 1);
});

test('sends a validated sync request and records the transaction lifecycle', async t => {
    const events = [];
    let receivedPayload;
    const baseUrl = await startServer(t, createAcademicApp({
        financeRequest: async payload => {
            receivedPayload = payload;
            return { status: 'CREATED', tuitionId: 'FEE-1' };
        },
        log: (...event) => events.push(event)
    }));

    const response = await fetch(`${baseUrl}/api/academic/tuition/sync`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'academic-request-1'
        },
        body: JSON.stringify({ studentId: 'SV001', term: 'HK1-2026', amount: '5000000' })
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.requestId, 'academic-request-1');
    assert.equal(body.finance.tuitionId, 'FEE-1');
    assert.equal(receivedPayload.amount, 5000000);
    assert.deepEqual(events.map(event => [event[3], event[4]]), [
        ['SENT', 'SENT_TO_FINANCE'],
        ['PROCESSED', 'SUCCESS']
    ]);
});

test('rejects invalid sync input before contacting Finance', async t => {
    const events = [];
    let calledFinance = false;
    const baseUrl = await startServer(t, createAcademicApp({
        financeRequest: async () => {
            calledFinance = true;
            return { status: 'CREATED' };
        },
        log: (...event) => events.push(event)
    }));

    const response = await fetch(`${baseUrl}/api/academic/tuition/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: 'SV001', term: 'HK1-2026', amount: 0 })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.equal(calledFinance, false);
    assert.equal(events[0][3], 'REJECTED');
});
