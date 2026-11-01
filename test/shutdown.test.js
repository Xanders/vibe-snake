const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    ShutdownCoordinator,
    ShutdownInProgressError,
} = require('../dist/shutdown.js');
const { TelegramPoller } = require('../dist/telegram-poller.js');
const { dispatchJsonMessage } = require('../dist/json-message.js');

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
    const paymentHandler = source.slice(
        source.indexOf("bot.on('message:successful_payment'"),
        source.indexOf('botPoller = new TelegramPoller(bot)'),
    );
    assert.doesNotMatch(paymentHandler, /catch\s*\(/);
    assert.match(source, /botPoller\s*=\s*new TelegramPoller\(bot\)/);
    assert.match(source, /await dispatchJsonMessage\(messageStr,\s*async data =>/);
    assert.match(source, /if\s*\(lifecycle\.isShuttingDown\)\s*{\s*ws\.close\(1012/);
    assert.match(source, /process\.on\('SIGTERM',\s*\(\)\s*=>\s*handleShutdownSignal\('SIGTERM'\)\)/);
    assert.match(source, /process\.on\('SIGINT',\s*\(\)\s*=>\s*handleShutdownSignal\('SIGINT'\)\)/);
});

test('a structured join write rejection propagates instead of becoming chat', async () => {
    let chatFallback = false;
    const writeError = new Error('create user failed');

    await assert.rejects(
        dispatchJsonMessage('{"type":"join-multiplayer","name":"Ada"}', async data => {
            assert.equal(data.type, 'join-multiplayer');
            throw writeError;
        }).then(isJson => {
            if (!isJson) chatFallback = true;
        }),
        writeError,
    );
    assert.equal(chatFallback, false);
});

test('Telegram shutdown waits for a successful payment write before confirming its update', async () => {
    const write = deferred();
    const handlerStarted = deferred();
    const calls = [];
    let pollCount = 0;
    const bot = {
        init: async () => calls.push('init'),
        handleUpdate: async update => {
            calls.push(`handle-${update.update_id}`);
            handlerStarted.resolve();
            await write.promise;
            calls.push(`written-${update.update_id}`);
        },
        api: {
            deleteWebhook: async () => calls.push('delete-webhook'),
            getUpdates: async (options, signal) => {
                calls.push(`get-${options.offset}-${signal ? 'poll' : 'confirm'}`);
                if (signal && pollCount++ === 0) return [{ update_id: 41 }];
                if (signal) return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                });
                return [];
            },
        },
    };

    const poller = new TelegramPoller(bot);
    const running = poller.start();
    await handlerStarted.promise;
    const stopping = poller.stop();
    await Promise.resolve();
    assert.equal(calls.includes('get-42-confirm'), false);

    write.resolve();
    await stopping;
    await running;
    assert.ok(calls.indexOf('written-41') < calls.indexOf('get-42-confirm'));
});

test('Telegram does not confirm a payment update whose write failed', async () => {
    const bot = {
        init: async () => {},
        handleUpdate: async () => { throw new Error('payment write failed'); },
        api: {
            deleteWebhook: async () => {},
            getUpdates: async (options, signal) => {
                if (signal) return [{ update_id: 51 }];
                throw new Error(`unexpected confirmation at ${options.offset}`);
            },
        },
    };

    const poller = new TelegramPoller(bot);
    await assert.rejects(poller.start(), /payment write failed/);
    await assert.rejects(poller.stop(), /payment write failed/);
});

test('Telegram initialization can be aborted without starting polling or hanging shutdown', async () => {
    let initSignal;
    let initAttempts = 0;
    let deleteWebhookCalled = false;
    const initStarted = deferred();
    const bot = {
        init: signal => {
            initSignal = signal;
            return new Promise((resolve, reject) => {
                let timer;
                const retry = () => {
                    initAttempts++;
                    if (initAttempts === 2) initStarted.resolve();
                    timer = setTimeout(retry, 1);
                };
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                }, { once: true });
                retry();
            });
        },
        handleUpdate: async () => {},
        api: {
            deleteWebhook: async () => { deleteWebhookCalled = true; },
            getUpdates: async () => [],
        },
    };

    const poller = new TelegramPoller(bot);
    const running = poller.start();
    await initStarted.promise;
    await poller.stop();
    await running;

    assert.equal(initSignal.aborted, true);
    assert.ok(initAttempts >= 2);
    assert.equal(deleteWebhookCalled, false);
});
