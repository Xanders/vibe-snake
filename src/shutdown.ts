export class ShutdownInProgressError extends Error {
    constructor(label: string) {
        super(`Cannot start ${label}: shutdown is in progress`);
        this.name = 'ShutdownInProgressError';
    }
}

export interface ShutdownPlan {
    stopProducers(): void | Promise<void>;
    stopBot(): void | Promise<void>;
    closeWebSockets(): void | Promise<void>;
    closeDatabase(): void | Promise<void>;
}

export async function settleAllOrThrow(
    promises: Promise<unknown>[],
    message: string,
): Promise<void> {
    const results = await Promise.allSettled(promises);
    const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, message);
}

export function failClosedOnUnexpectedRejection(
    task: Promise<unknown>,
    isShuttingDown: () => boolean,
    onFailure: (error: unknown) => void,
): void {
    void task.catch(error => {
        if (!isShuttingDown()) onFailure(error);
    });
}

export function abortAndClear(controllers: Set<AbortController>): void {
    for (const controller of controllers) controller.abort();
    controllers.clear();
}

export function terminateRejectedTransport(transport: { terminate(): void }): void {
    transport.terminate();
}

export class ShutdownCoordinator {
    private acceptingWork = true;
    private readonly pending = new Set<Promise<unknown>>();
    private readonly failedDuringShutdown = new Map<Promise<unknown>, unknown>();
    private shutdownPromise: Promise<void> | null = null;

    constructor(private readonly plan: ShutdownPlan) {}

    get isShuttingDown(): boolean {
        return !this.acceptingWork;
    }

    track<T>(label: string, task: () => Promise<T>): Promise<T> {
        if (!this.acceptingWork) {
            return Promise.reject(new ShutdownInProgressError(label));
        }

        const promise = Promise.resolve().then(task);
        this.pending.add(promise);
        promise.then(
            () => this.pending.delete(promise),
            error => {
                if (!this.acceptingWork) this.failedDuringShutdown.set(promise, error);
                this.pending.delete(promise);
            },
        );
        return promise;
    }

    shutdown(signal: string): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;

        this.acceptingWork = false;
        this.shutdownPromise = this.run(signal);
        return this.shutdownPromise;
    }

    private async run(signal: string): Promise<void> {
        const errors: Error[] = [];
        const attempt = async (label: string, action: () => void | Promise<void>) => {
            try {
                await action();
            } catch (error) {
                const wrapped = new Error(`${label} failed during ${signal}`) as Error & { cause?: unknown };
                wrapped.cause = error;
                errors.push(wrapped);
            }
        };

        await attempt('stop producers', () => this.plan.stopProducers());
        await attempt('stop bot', () => this.plan.stopBot());
        await attempt('close websockets', () => this.plan.closeWebSockets());
        await attempt('drain pending writes', () => this.drainPending());
        await attempt('close database', () => this.plan.closeDatabase());

        if (errors.length > 0) {
            throw new AggregateError(errors, `Shutdown after ${signal} completed with errors`);
        }
    }

    private async drainPending(): Promise<void> {
        while (this.pending.size > 0) {
            await Promise.allSettled(Array.from(this.pending));
        }

        const failures = Array.from(this.failedDuringShutdown.values());
        this.failedDuringShutdown.clear();
        if (failures.length > 0) {
            throw new AggregateError(failures, 'One or more pending writes failed');
        }
    }
}
