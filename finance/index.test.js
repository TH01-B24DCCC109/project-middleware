const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFinanceApp, readRecords, writeRecords } = require('./index');

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

test('persists and reads tuition records', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-sync-test-'));
    const file = path.join(directory, 'records.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const records = [{ requestId: 'request-1', amount: 5000000 }];
    writeRecords(records, file);

    assert.deepEqual(readRecords(file), records);
});

test('reports corrupted tuition records instead of treating them as empty', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-sync-test-'));
    const file = path.join(directory, 'records.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(file, '{invalid json');

    assert.throws(() => readRecords(file), SyntaxError);
});

test('creates a tuition record through REST and ignores a repeated request ID', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-sync-test-'));
    const file = path.join(directory, 'records.json');
    const events = [];
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const baseUrl = await startServer(t, createFinanceApp({
        dataFile: file,
        log: (...event) => events.push(event)
    }));
    const request = {
        requestId: 'finance-request-1',
        studentId: 'SV001',
        term: 'HK1-2026',
        amount: 5000000
    };

    const firstResponse = await fetch(`${baseUrl}/api/tuition/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });
    const firstBody = await firstResponse.json();
    const duplicateResponse = await fetch(`${baseUrl}/api/tuition/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });
    const duplicateBody = await duplicateResponse.json();

    assert.equal(firstResponse.status, 201);
    assert.equal(firstBody.status, 'CREATED');
    assert.equal(duplicateResponse.status, 200);
    assert.equal(duplicateBody.status, 'DUPLICATE');
    assert.equal(duplicateBody.tuitionId, firstBody.tuitionId);
    assert.equal(readRecords(file).length, 1);
    assert.ok(events.some(event => event[3] === 'RECEIVED'));
    assert.ok(events.some(event => event[4] === 'DUPLICATE_IGNORED'));
});
