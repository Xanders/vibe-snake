import * as http from 'http';

export interface UpgradeRequiredResponse {
    writeHead(statusCode: number, headers: Record<string, string | number>): unknown;
    end(body: string): unknown;
}

export function respondUpgradeRequired(response: UpgradeRequiredResponse): void {
    const body = http.STATUS_CODES[426] ?? 'Upgrade Required';
    response.writeHead(426, {
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'text/plain',
    });
    response.end(body);
}
