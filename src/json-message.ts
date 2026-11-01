export async function dispatchJsonMessage(
    message: string,
    isKnownCommand: (data: any) => boolean,
    handler: (data: any) => void | Promise<void>,
): Promise<boolean> {
    let data: any;
    try {
        data = JSON.parse(message);
    } catch {
        return false;
    }

    if (!isKnownCommand(data)) return false;
    await handler(data);
    return true;
}
