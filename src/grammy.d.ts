declare module 'grammy' {
  // Minimal subset of what is used in the project.
  export interface SuccessfulPayment {
    invoice_payload: string;
  }

  export interface TelegramMessage {
    successful_payment: SuccessfulPayment;
  }

  export interface Api {
    createInvoiceLink(title: string, description: string, payload: string, providerData: string, currency: string, prices: { label: string; amount: number }[]): Promise<string>;
  }

  export interface Context {
    message: TelegramMessage;
    from?: { id: number };
  }

  export class Bot<TContext = Context> {
    constructor(token: string);
    on(event: string, handler: (ctx: TContext) => Promise<void> | void): void;
    start(): void;
    api: Api;
  }
}