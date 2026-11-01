export async function dispatchJsonMessage(
    message: string,
    handler: (data: any) => void | Promise<void>,
): Promise<boolean> {
    let data: any;
    try {
        data = JSON.parse(message);
    } catch {
        return false;
    }

    await handler(data);
    return true;
}
