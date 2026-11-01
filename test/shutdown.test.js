const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    ShutdownCoordinator,
    ShutdownInProgressError,
    abortAndClear,
    failClosedOnUnexpectedRejection,
    settleAllOrThrow,
    terminateRejectedTransport,
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
    assert.match(source, /await dispatchJsonMessage\(\s*messageStr,[\s\S]*?async data =>/);
    assert.match(source, /beginShutdown\('TELEGRAM_POLLER_FAILURE',\s*1\)/);
    assert.match(source, /await settleAllOrThrow\(playerWrites,/);
    assert.match(source, /if\s*\(lifecycle\.isShuttingDown\)\s*{\s*terminateRejectedTransport\(ws\)/);
    assert.match(source, /invoiceControllers\.add\(controller\)[\s\S]*?createInvoiceLink\([\s\S]*?controller\.signal/);
    assert.match(source, /abortAndClear\(invoiceControllers\)/);
    assert.match(source, /process\.on\('SIGTERM',\s*\(\)\s*=>\s*handleShutdownSignal\('SIGTERM'\)\)/);
    assert.match(source, /process\.on\('SIGINT',\s*\(\)\s*=>\s*handleShutdownSignal\('SIGINT'\)\)/);
});

test('a structured join write rejection propagates instead of becoming chat', async () => {
    let chatFallback = false;
    const writeError = new Error('create user failed');

    await assert.rejects(
        dispatchJsonMessage(
            '{"type":"join-multiplayer","name":"Ada"}',
            data => data.type === 'join-multiplayer',
            async data => {
            assert.equal(data.type, 'join-multiplayer');
            throw writeError;
            },
        ).then(isJson => {
            if (!isJson) chatFallback = true;
        }),
        writeError,
    );
    assert.equal(chatFallback, false);
});

test('unmatched numeric JSON still falls through to numeric chat and cheat handling', async () => {
    for (const message of ['123', '10112026', '62021110']) {
        let commandRan = false;
        const handled = await dispatchJsonMessage(
            message,
            data => data !== null && typeof data === 'object' && data.type === 'join-multiplayer',
            async () => { commandRan = true; },
        );
        assert.equal(handled, false);
        assert.equal(commandRan, false);
    }
});

test('score failure waits for every accepted player continuation before rejecting', async () => {
    const secondCredit = deferred();
    const events = [];
    const first = Promise.reject(new Error('credit-a failed'));
    const second = (async () => {
        events.push('credit-b-started');
        await secondCredit.promise;
        events.push('cooldown-b-finished');
    })();

    const settled = settleAllOrThrow([first, second], 'score writes failed');
    await Promise.resolve();
    let rejected = false;
    void settled.catch(() => { rejected = true; });
    await Promise.resolve();
    assert.equal(rejected, false);

    secondCredit.resolve();
    await assert.rejects(settled, error => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.errors.length, 1);
        return true;
    });
    assert.deepEqual(events, ['credit-b-started', 'cooldown-b-finished']);
});

test('an unexpected critical poller failure triggers fail-closed shutdown', async () => {
    const task = deferred();
    const failures = [];
    failClosedOnUnexpectedRejection(
        task.promise,
        () => false,
        error => failures.push(error),
    );

    const failure = new Error('payment poller stopped');
    task.reject(failure);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(failures, [failure]);
});

test('critical poller completion during an existing shutdown does not start another shutdown', async () => {
    const task = deferred();
    let callbackCount = 0;
    failClosedOnUnexpectedRejection(
        task.promise,
        () => true,
        () => { callbackCount++; },
    );

    task.reject(new Error('expected stop failure'));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(callbackCount, 0);
});

test('stopping producers aborts and releases a stalled invoice request', async () => {
    const controllers = new Set();
    const controller = new AbortController();
    controllers.add(controller);
    const invoice = new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('invoice aborted')), { once: true });
    });

    abortAndClear(controllers);

    await assert.rejects(invoice, /invoice aborted/);
    assert.equal(controller.signal.aborted, true);
    assert.equal(controllers.size, 0);
});

test('a WebSocket admitted after shutdown starts is terminated immediately', () => {
    let state = 'OPEN';
    const lateSocket = {
        close: () => { state = 'CLOSING'; },
        terminate: () => { state = 'TERMINATED'; },
    };

    terminateRejectedTransport(lateSocket);

    assert.equal(state, 'TERMINATED');
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
                const kind = signal && options.timeout === 0 ? 'confirm' : 'poll';
                calls.push(`get-${options.offset}-${kind}`);
                if (kind === 'poll' && pollCount++ === 0) return [{ update_id: 41 }];
                if (kind === 'poll') return new Promise((resolve, reject) => {
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

test('a stalled final Telegram confirmation is aborted promptly', async () => {
    let confirmationAborted = false;
    let pollCount = 0;
    const bot = {
        init: async () => {},
        handleUpdate: async () => {},
        api: {
            deleteWebhook: async () => {},
            getUpdates: async (options, signal) => {
                if (options.timeout !== 0 && pollCount++ === 0) return [{ update_id: 61 }];
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        if (options.timeout === 0) confirmationAborted = true;
                        reject(new Error('aborted request'));
                    }, { once: true });
                });
            },
        },
    };

    const poller = new TelegramPoller(bot, 5);
    const running = poller.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(poller.stop(), /aborted request/);
    await running;
    assert.equal(confirmationAborted, true);
});

test('Telegram does not confirm a payment update whose write failed', async () => {
    const bot = {
        init: async () => {},
        handleUpdate: async () => { throw new Error('payment write failed'); },
        api: {
            deleteWebhook: async () => {},
            getUpdates: async (options, signal) => {
                if (options.timeout !== 0) return [{ update_id: 51 }];
                throw new Error(`unexpected confirmation at ${options.offset}`);
            },
        },
    };

    const poller = new TelegramPoller(bot);
    await assert.rejects(poller.start(), /payment write failed/);
    await assert.rejects(poller.stop(), /payment write failed/);
});

test('Telegram confirms an earlier successful payment before propagating a later batch failure', async () => {
    const calls = [];
    const bot = {
        init: async () => {},
        handleUpdate: async update => {
            calls.push(`handle-${update.update_id}`);
            if (update.update_id === 42) throw new Error('payment 42 write failed');
        },
        api: {
            deleteWebhook: async () => {},
            getUpdates: async (options) => {
                calls.push(`get-${options.offset}-${options.timeout}`);
                if (options.timeout !== 0) return [{ update_id: 41 }, { update_id: 42 }];
                return [];
            },
        },
    };

    const poller = new TelegramPoller(bot);
    await assert.rejects(poller.start(), /payment 42 write failed/);
    await assert.rejects(poller.stop(), /payment 42 write failed/);

    assert.deepEqual(calls, [
        'get-1-30',
        'handle-41',
        'handle-42',
        'get-42-0',
    ]);
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
