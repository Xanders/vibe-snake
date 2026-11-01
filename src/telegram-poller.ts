export interface TelegramUpdate {
    update_id: number;
}

export interface TelegramPollingBot<TUpdate extends TelegramUpdate> {
    init(signal?: AbortSignal): Promise<void>;
    handleUpdate(update: TUpdate): Promise<void>;
    api: {
        deleteWebhook(options: { drop_pending_updates?: boolean }, signal?: AbortSignal): Promise<unknown>;
        getUpdates(
            options: { offset?: number; limit?: number; timeout?: number; allowed_updates?: string[] },
            signal?: AbortSignal,
        ): Promise<TUpdate[]>;
    };
}

/**
 * Minimal long poller with shutdown-safe acknowledgement semantics.
 *
 * Telegram confirms every update below the next getUpdates offset. We therefore
 * advance the offset only after middleware has completed successfully, and the
 * final shutdown request only confirms that last successful update.
 */
export class TelegramPoller<TUpdate extends TelegramUpdate> {
    private controller: AbortController | null = null;
    private startPromise: Promise<void> | null = null;
    private running = false;
    private initialized = false;
    private lastCompletedUpdateId = 0;
    private terminalError: unknown = null;

    constructor(private readonly bot: TelegramPollingBot<TUpdate>) {}

    start(): Promise<void> {
        if (this.startPromise) return this.startPromise;

        this.running = true;
        this.controller = new AbortController();
        this.startPromise = this.run(this.controller.signal).catch(error => {
            this.terminalError = error;
            throw error;
        }).finally(() => {
            this.running = false;
        });
        return this.startPromise;
    }

    async stop(): Promise<void> {
        if (!this.startPromise) return;

        this.running = false;
        this.controller?.abort();
        await this.startPromise;

        if (this.terminalError || !this.initialized) return;
        await this.bot.api.getUpdates({
            offset: this.lastCompletedUpdateId + 1,
            limit: 1,
            timeout: 0,
        });
    }

    private async run(signal: AbortSignal): Promise<void> {
        try {
            await this.bot.init(signal);
            if (!this.running) return;

            await this.retryWhileRunning(
                () => this.bot.api.deleteWebhook({}, signal),
                signal,
            );
            if (!this.running) return;
            this.initialized = true;

            while (this.running) {
                const updates = await this.retryWhileRunning(
                    () => this.bot.api.getUpdates({
                        offset: this.lastCompletedUpdateId + 1,
                        timeout: 30,
                        allowed_updates: ['message'],
                    }, signal),
                    signal,
                );

                if (!updates) return;

                for (const update of updates) {
                    if (!this.running) return;
                    await this.bot.handleUpdate(update);
                    this.lastCompletedUpdateId = update.update_id;
                }
            }
        } catch (error) {
            if (signal.aborted) return;
            throw error;
        }
    }

    private async retryWhileRunning<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
        while (this.running) {
            try {
                return await task();
            } catch (error) {
                if (signal.aborted || !this.running) return undefined;
                const code = (error as { error_code?: unknown } | null)?.error_code;
                if (code === 401 || code === 409) throw error;
                await this.waitForRetry(signal);
            }
        }
        return undefined;
    }

    private waitForRetry(signal: AbortSignal): Promise<void> {
        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, 3000);
            signal.addEventListener('abort', finish, { once: true });
        });
    }
}
