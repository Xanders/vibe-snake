import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

export interface User {
    token: string;
    name: string;
}

const DB_PATH = path.join(__dirname, '../db/snake.db');
let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDB(): Promise<void> {
    const exists = fs.existsSync(DB_PATH);
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    if (!exists) {
        await createSchema();
    } else {
        await verifySchema();
    }
}

async function createSchema(): Promise<void> {
    await db.exec(`CREATE TABLE IF NOT EXISTS users (token TEXT PRIMARY KEY, name TEXT)`);
}

async function verifySchema(): Promise<void> {
    try {
        await db.get(`SELECT token, name FROM users LIMIT 1`);
    } catch {
        await createSchema();
    }
}

export async function createUser(name: string, token: string): Promise<void> {
    await db.run(`INSERT INTO users (token, name) VALUES (?, ?)`, token, name);
}

export async function getUserByToken(token: string): Promise<User | undefined> {
    return db.get<User>(`SELECT token, name FROM users WHERE token = ?`, token);
}
