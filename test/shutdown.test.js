const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    ShutdownCoordinator,
    ShutdownInProgressError,
} = require('../dist/shutdown.js');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function plan(overrides = {}) {
    return {
        stopProducers: async () => {},
        stopBot: async () => {},
        closeWebSockets: async () => {},
        closeDatabase: async () => {},
        ...overrides,
    };
}

test('shutdown rejects a late join without invoking its task', async () => {
    const producerStopped = deferred();
    const coordinator = new ShutdownCoordinator(plan({
        stopProducers: () => producerStopped.promise,
    }));

    const shutdown = coordinator.shutdown('SIGTERM');
    let invoked = false;

    await assert.rejects(
        coordinator.track('late-join', async () => {
            invoked = true;
        }),
        ShutdownInProgressError,
    );
    assert.equal(invoked, false);

    producerStopped.resolve();
    await shutdown;
});

test('shutdown drains score and payment writes before closing SQLite', async () => {
    const events = [];
    const score = deferred();
    const payment = deferred();
    const coordinator = new ShutdownCoordinator(plan({
        stopProducers: async () => events.push('producers-stopped'),
        stopBot: async () => events.push('bot-stopped'),
        closeWebSockets: async () => events.push('websockets-closed'),
        closeDatabase: async () => events.push('database-closed'),
    }));

    const scoreWrite = coordinator.track('score', async () => {
        events.push('score-started');
        await score.promise;
        events.push('score-finished');
    });
    const paymentWrite = coordinator.track('payment', async () => {
        events.push('payment-started');
        await payment.promise;
        events.push('payment-finished');
    });
    await Promise.resolve();

    const shutdown = coordinator.shutdown('SIGTERM');
    await Promise.resolve();
    assert.equal(events.includes('database-closed'), false);

    score.resolve();
    await scoreWrite;
    assert.equal(events.includes('database-closed'), false);

    payment.resolve();
    await paymentWrite;
    await shutdown;

    assert.ok(events.indexOf('producers-stopped') < events.indexOf('bot-stopped'));
    assert.ok(events.indexOf('bot-stopped') < events.indexOf('websockets-closed'));
    assert.ok(events.indexOf('score-finished') < events.indexOf('database-closed'));
    assert.ok(events.indexOf('payment-finished') < events.indexOf('database-closed'));
    assert.equal(events.at(-1), 'database-closed');
});

test('repeated signals share one shutdown and execute every step once', async () => {
    const calls = {
        stopProducers: 0,
        stopBot: 0,
        closeWebSockets: 0,
        closeDatabase: 0,
    };
    const coordinator = new ShutdownCoordinator(plan({
        stopProducers: async () => { calls.stopProducers++; },
        stopBot: async () => { calls.stopBot++; },
        closeWebSockets: async () => { calls.closeWebSockets++; },
        closeDatabase: async () => { calls.closeDatabase++; },
    }));

    const first = coordinator.shutdown('SIGTERM');
    const second = coordinator.shutdown('SIGINT');

    assert.equal(first, second);
    await first;
    assert.deepEqual(calls, {
        stopProducers: 1,
        stopBot: 1,
        closeWebSockets: 1,
        closeDatabase: 1,
    });
});

test('partial cleanup failures do not skip draining or SQLite close', async () => {
    const events = [];
    const pending = deferred();
    const coordinator = new ShutdownCoordinator(plan({
        stopProducers: async () => {
            events.push('producers-attempted');
            throw new Error('interval failure');
        },
        stopBot: async () => {
            events.push('bot-attempted');
            throw new Error('bot failure');
        },
        closeWebSockets: async () => events.push('websockets-attempted'),
        closeDatabase: async () => events.push('database-attempted'),
    }));
    const write = coordinator.track('payment', async () => {
        await pending.promise;
        events.push('pending-drained');
    });
    await Promise.resolve();

    const shutdown = coordinator.shutdown('SIGTERM');
    pending.resolve();
    await write;

    await assert.rejects(shutdown, error => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.errors.length, 2);
        return true;
    });
    assert.deepEqual(events, [
        'producers-attempted',
        'pending-drained',
        'bot-attempted',
        'websockets-attempted',
        'database-attempted',
    ]);
});

test('a failed pending write is reported but SQLite close is still attempted', async () => {
    const pending = deferred();
    let databaseClosed = false;
    const coordinator = new ShutdownCoordinator(plan({
        closeDatabase: async () => { databaseClosed = true; },
    }));
    const write = coordinator.track('score', async () => pending.promise);
    await Promise.resolve();

    const shutdown = coordinator.shutdown('SIGTERM');
    pending.reject(new Error('write failed'));
    await assert.rejects(write, /write failed/);
    await assert.rejects(shutdown, error => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.errors.length, 1);
        assert.equal(error.errors[0].message, 'drain pending writes failed during SIGTERM');
        return true;
    });
    assert.equal(databaseClosed, true);
});

test('server wires score, joins, payments and repeated signals through the lifecycle', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf8');

    assert.match(source, /lifecycle\.track\('multiplayer-score',\s*recordMultiplayerScore\)/);
    assert.match(source, /lifecycle\.track\('websocket-message',\s*async\s*\(\)\s*=>/);
    assert.match(source, /lifecycle\.track\('telegram-payment',\s*async\s*\(\)\s*=>/);
    assert.match(source, /if\s*\(lifecycle\.isShuttingDown\)\s*{\s*ws\.close\(1012/);
    assert.match(source, /process\.on\('SIGTERM',\s*\(\)\s*=>\s*handleShutdownSignal\('SIGTERM'\)\)/);
    assert.match(source, /process\.on\('SIGINT',\s*\(\)\s*=>\s*handleShutdownSignal\('SIGINT'\)\)/);
});
